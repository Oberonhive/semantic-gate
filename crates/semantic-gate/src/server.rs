//! The HTTP surface — capability `API` in `docs/spec/api.md`, plus the
//! `ERR-001` envelope fallback (`docs/spec/err.md`).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{Json, Router, http::StatusCode, http::Uri, routing::get};
use semantic_gate_core::{Envelope, ErrorCode};
use serde::Serialize;
use tokio::net::TcpListener;

use crate::config::Config;

/// Bind and serve until `SIGTERM` (`API-001`, `API-002`, `API-003`).
///
/// Returns once the listening socket has been released and in-flight requests
/// have finished.
///
/// # Errors
/// If the configured address cannot be bound.
pub async fn serve(config: &Config) -> std::io::Result<()> {
    let routes = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .fallback(ns_not_found);

    let listener = TcpListener::bind(config.listen.http).await?;
    axum::serve(listener, routes)
        .with_graceful_shutdown(terminated())
        .await
}

/// Assigns each request a `request_id` (`ERR-001.S2`): this process's
/// startup time, captured once, combined with an atomic counter that
/// advances on every call, hex-formatted. Uniqueness within this process —
/// the only guarantee `ERR-001.S2` asserts — comes from the counter alone;
/// the startup component is there so two processes don't trivially collide.
/// Lives here, daemon-side, rather than in `semantic-gate-core`, which stays
/// clock-free by law (see that crate's docs).
fn next_request_id() -> String {
    static STARTUP_NANOS: OnceLock<u128> = OnceLock::new();
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let startup = *STARTUP_NANOS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    });
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{startup:x}-{sequence:x}")
}

/// `ERR-001` — every unmatched path answers the closed envelope with
/// `ns_not_found`. The semantic surface is entirely namespace-prefixed
/// (`/{ns}/…`), so a path this router doesn't otherwise recognise names a
/// namespace that doesn't exist, taking the first path segment as that name.
/// The 404 status for `ns_not_found` lives at this single call site
/// (`docs/spec/err.md`'s mapping table has exactly one reachable row today;
/// a second reachable code earns a second call site, not a general mapping
/// function — see task 0012's plan).
async fn ns_not_found(uri: Uri) -> (StatusCode, Json<Envelope>) {
    let namespace = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();

    (
        StatusCode::NOT_FOUND,
        Json(Envelope {
            code: ErrorCode::NsNotFound,
            message: format!("no namespace named {namespace}"),
            request_id: next_request_id(),
            hint: None,
        }),
    )
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
    components: Vec<&'static str>,
}

/// `API-002` — readiness, answered from the list of components not yet ready.
async fn readyz() -> (StatusCode, Json<Ready>) {
    // Nothing that can be un-ready has been specified yet, so the list is
    // empty and the answer derives from it rather than being asserted.
    let waiting: Vec<&'static str> = Vec::new();

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
