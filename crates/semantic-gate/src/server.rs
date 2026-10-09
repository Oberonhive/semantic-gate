//! The HTTP surface — capability `API` in `docs/spec/api.md`, plus the
//! `ERR-001` envelope fallback (`docs/spec/err.md`).
//!
//! Beyond the specified probes it serves the semantic REST surface:
//! `GET /catalog`, `GET /{ns}/metadata`, `POST /{ns}/query`,
//! `POST /{ns}/explain`. A namespace is checked before its body is read.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::{CONTENT_TYPE, HeaderValue};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use semantic_gate_core::query::SemanticQuery;
use semantic_gate_core::{Envelope, ErrorCode};
use serde::{Serialize, de::DeserializeOwned};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::config::{Config, Listener};
use crate::failure::{Failure, status};
use crate::pipeline::{Gate, next_request_id};

/// Bind and serve until `SIGTERM` (`API-001`, `API-002`, `API-003`).
///
/// Returns once the listening socket has been released and in-flight requests
/// have finished.
///
/// # Errors
/// If the configured address cannot be bound, or a datasource cannot be opened.
pub async fn serve(config: &Config) -> std::io::Result<()> {
    let listener = TcpListener::bind(config.listen.http).await?;
    let gate = Gate::start(config).map_err(std::io::Error::other)?;

    let backend = std::sync::Arc::new(gate.clone());
    for surface in &config.listeners {
        let Listener::Pgwire { listen, namespace } = surface;
        let socket = TcpListener::bind(listen).await?;
        let (namespace, backend) = (namespace.clone(), backend.clone());
        tokio::spawn(async move {
            if let Err(error) = semantic_gate_sql::serve(socket, namespace, backend).await {
                eprintln!("pgwire listener stopped: {error}");
            }
        });
    }

    let cors = {
        let gate = gate.clone();
        CorsLayer::new()
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([CONTENT_TYPE])
            .allow_origin(AllowOrigin::predicate(
                move |origin: &HeaderValue, parts| {
                    let ns = parts.uri.path().trim_start_matches('/').split('/').next();
                    let ns = ns.filter(|s| *s != "catalog");
                    origin
                        .to_str()
                        .is_ok_and(|origin| gate.origin_allowed(ns, origin))
                },
            ))
    };

    let routes = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/catalog", get(catalog))
        .route("/{ns}/metadata", get(metadata))
        .route("/{ns}/query", post(query))
        .route("/{ns}/explain", post(explain))
        .fallback(unmatched)
        .layer(cors)
        .with_state(gate);

    axum::serve(listener, routes)
        .with_graceful_shutdown(terminated())
        .await
}

/// A failure bound to this request: the closed envelope and its status.
struct ApiError(Envelope);

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        Self(failure.envelope(next_request_id()))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (status(self.0.code), Json(self.0)).into_response()
    }
}

/// The body is parsed only after the namespace is known, and a malformed one
/// is `invalid_params` with serde's own message.
fn parse<T: DeserializeOwned>(body: &Bytes) -> Result<T, Failure> {
    serde_json::from_slice(body).map_err(|e| Failure::new(ErrorCode::InvalidParams, e.to_string()))
}

#[derive(Serialize)]
struct Catalog {
    namespaces: Vec<String>,
}

async fn catalog(State(gate): State<Gate>) -> Json<Catalog> {
    Json(Catalog {
        namespaces: gate.names(),
    })
}

async fn metadata(
    State(gate): State<Gate>,
    Path(ns): Path<String>,
) -> Result<Json<semantic_gate_core::metadata::Metadata>, ApiError> {
    Ok(Json(gate.metadata(&ns)?))
}

async fn query(
    State(gate): State<Gate>,
    Path(ns): Path<String>,
    body: Bytes,
) -> Result<Json<semantic_gate_core::response::Response>, ApiError> {
    if !gate.has(&ns) {
        return Err(gate.not_found(&ns).into());
    }
    let request_id = next_request_id();
    let query: SemanticQuery = parse(&body)?;
    gate.query(&ns, query, &request_id)
        .await
        .map(Json)
        .map_err(|f| ApiError(f.envelope(request_id)))
}

async fn explain(
    State(gate): State<Gate>,
    Path(ns): Path<String>,
    body: Bytes,
) -> Result<Json<semantic_gate_core::response::Explain>, ApiError> {
    if !gate.has(&ns) {
        return Err(gate.not_found(&ns).into());
    }
    let request_id = next_request_id();
    let query: SemanticQuery = parse(&body)?;
    gate.explain(&ns, query, &request_id)
        .await
        .map(Json)
        .map_err(|f| ApiError(f.envelope(request_id)))
}

/// `ERR-001` — every unmatched path answers the closed envelope with
/// `ns_not_found`. The semantic surface is entirely namespace-prefixed
/// (`/{ns}/…`), so a path this router doesn't otherwise recognise names a
/// namespace that doesn't exist, taking the first path segment as that name.
/// (Under an existing namespace the message says the route is unknown; the
/// taxonomy has no code for it.)
async fn unmatched(State(gate): State<Gate>, uri: Uri) -> ApiError {
    let namespace = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();
    let mut failure = gate.not_found(namespace);
    if gate.has(namespace) {
        failure.message = format!("no route {} in namespace {namespace}", uri.path());
        failure.hint = None;
    }
    failure.into()
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

/// `API-001` — liveness. Asks nothing of anything else, so that a supervisor
/// restarting on a failed probe restarts a dead process rather than one whose
/// warehouse is briefly unreachable.
async fn healthz() -> Json<Health> {
    Json(Health { status: "ok" })
}

#[derive(Serialize)]
struct Ready {
    status: &'static str,
    /// The components the gate is still waiting on. Empty means ready.
    components: Vec<String>,
}

/// `API-002` — readiness, answered from the list of components not yet ready:
/// each namespace whose provider has not completed its handshake.
async fn readyz(State(gate): State<Gate>) -> (StatusCode, Json<Ready>) {
    let waiting = gate.waiting();

    if waiting.is_empty() {
        (
            StatusCode::OK,
            Json(Ready {
                status: "ready",
                components: waiting,
            }),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Ready {
                status: "not_ready",
                components: waiting,
            }),
        )
    }
}

/// `API-003` — resolves when the process is asked to stop, so that
/// `axum::serve` stops accepting, drains, and releases the port.
async fn terminated() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install the SIGTERM handler");

    tokio::select! {
        _ = terminate.recv() => {}
        result = tokio::signal::ctrl_c() => {
            // Ctrl-C in a terminal is the same intent as SIGTERM from a
            // supervisor; a failure to install that handler is not a reason to
            // refuse to shut down on SIGTERM.
            let _ = result;
        }
    }
}
