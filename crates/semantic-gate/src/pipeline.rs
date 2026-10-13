//! The request pipeline: namespace → limits → `plan` → execute → response.
//!
//! One implementation behind every surface — REST and the SQL wire call the
//! same functions, so BI gets exactly the semantics agents get. Also owns the
//! `request_id` generator, because the pipeline is where a request begins.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use semantic_gate_core::metadata::Metadata;
use semantic_gate_core::protocol::PlanParams;
use semantic_gate_core::query::{EvaluationContext, SemanticQuery};
use semantic_gate_core::response::{Explain, Response};
use semantic_gate_core::{Envelope, ErrorCode};

use crate::calendar;
use crate::config::{Config, Limits};
use crate::connector::Connector;
use crate::failure::Failure;
use crate::provider::Provider;

/// Assigns each request a `request_id` (`ERR-001.S2`): this process's
/// startup time, captured once, combined with an atomic counter that
/// advances on every call, hex-formatted. Uniqueness within this process —
/// the only guarantee `ERR-001.S2` asserts — comes from the counter alone;
/// the startup component is there so two processes don't trivially collide.
/// Lives here, daemon-side, rather than in `semantic-gate-core`, which stays
/// clock-free by law (see that crate's docs).
pub fn next_request_id() -> String {
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

struct Runtime {
    provider: Arc<Provider>,
    connector: Arc<Connector>,
    limits: Limits,
    cors_origins: Vec<String>,
}

/// Every configured namespace, ready or not. Cheap to clone.
#[derive(Clone)]
pub struct Gate {
    namespaces: Arc<BTreeMap<String, Runtime>>,
}

impl Gate {
    /// Open connectors and start every provider in parallel; returns at once.
    ///
    /// # Errors
    /// A datasource that cannot be opened — a configuration fault, so startup
    /// refuses it naming the datasource.
    pub fn start(config: &Config) -> Result<Self, String> {
        let mut connectors = BTreeMap::new();
        for (name, datasource) in &config.datasources {
            let connector =
                Connector::open(datasource).map_err(|e| format!("datasources.{name}: {e}"))?;
            connectors.insert(name.as_str(), Arc::new(connector));
        }
        let namespaces = config
            .namespaces
            .iter()
            .map(|(name, ns)| {
                // Validated by the config: the datasource exists.
                let connector = Arc::clone(&connectors[ns.datasource.as_str()]);
                let provider = Provider::start(name.clone(), ns.cubes.clone(), connector.dialect());
                let runtime = Runtime {
                    provider,
                    connector,
                    limits: ns.limits,
                    cors_origins: ns.cors.origins.clone(),
                };
                (name.clone(), runtime)
            })
            .collect();
        Ok(Self {
            namespaces: Arc::new(namespaces),
        })
    }

    /// Configured namespace names.
    pub fn names(&self) -> Vec<String> {
        self.namespaces.keys().cloned().collect()
    }

    /// `namespace/<name>` for each provider not yet ready (`API-002`).
    pub fn waiting(&self) -> Vec<String> {
        self.namespaces
            .iter()
            .filter(|(_, rt)| !rt.provider.ready())
            .map(|(name, _)| format!("namespace/{name}"))
            .collect()
    }

    /// Whether `origin` may call `namespace` from a browser; `None` asks about
    /// any namespace (the catalog).
    pub fn origin_allowed(&self, namespace: Option<&str>, origin: &str) -> bool {
        let allowed = |rt: &Runtime| rt.cors_origins.iter().any(|o| o == origin);
        match namespace {
            Some(name) => self.namespaces.get(name).is_some_and(allowed),
            None => self.namespaces.values().any(allowed),
        }
    }

    /// The `ns_not_found` failure for `namespace`; its hint lists the
    /// configured namespaces only when there are any.
    pub fn not_found(&self, namespace: &str) -> Failure {
        let failure = Failure::new(
            ErrorCode::NsNotFound,
            format!("no namespace named {namespace}"),
        );
        if self.namespaces.is_empty() {
            failure
        } else {
            failure.hint(format!("namespaces: {}", self.names().join(", ")))
        }
    }

    fn runtime(&self, namespace: &str) -> Result<&Runtime, Failure> {
        self.namespaces
            .get(namespace)
            .ok_or_else(|| self.not_found(namespace))
    }

    /// Whether `namespace` exists.
    pub fn has(&self, namespace: &str) -> bool {
        self.namespaces.contains_key(namespace)
    }

    /// The namespace's published metadata.
    pub fn metadata(&self, namespace: &str) -> Result<Metadata, Failure> {
        self.runtime(namespace)?.provider.metadata()
    }

    async fn plan(
        &self,
        rt: &Runtime,
        mut query: SemanticQuery,
    ) -> Result<(semantic_gate_core::protocol::Plan, Option<u64>), Failure> {
        let Limits {
            default_limit,
            max_limit,
        } = rt.limits;
        // Without an explicit limit the provider is asked for one row more
        // than the default: seeing it proves the result is too large, so it
        // is refused instead of silently truncated.
        let overflow_at = match query.limit {
            Some(limit) if limit > max_limit => {
                return Err(Failure::new(
                    ErrorCode::ResultTooLarge,
                    format!("limit {limit} exceeds this namespace's maximum of {max_limit}"),
                )
                .hint(format!(
                    "ask for at most {max_limit} rows, or narrow with filters"
                )));
            }
            Some(_) => None,
            None => {
                query.limit = Some(default_limit + 1);
                Some(default_limit)
            }
        };
        let plan = rt
            .provider
            .plan(&PlanParams {
                query,
                dialect: rt.connector.dialect(),
                context: EvaluationContext {
                    evaluation_time: calendar::now(),
                    timezone: "UTC".to_owned(),
                },
            })
            .await?;
        Ok((plan, overflow_at))
    }

    /// Run a query (`POST /{ns}/query`, a SQL statement).
    pub async fn query(
        &self,
        namespace: &str,
        query: SemanticQuery,
        request_id: &str,
    ) -> Result<Response, Failure> {
        let rt = self.runtime(namespace)?;
        let (plan, overflow_at) = self.plan(rt, query).await?;
        let rows = rt
            .connector
            .execute(&plan.sql, namespace, request_id)
            .await?;
        if let Some(default_limit) = overflow_at.filter(|n| rows.len() as u64 > *n) {
            return Err(Failure::new(
                ErrorCode::ResultTooLarge,
                format!("the result has more than {default_limit} rows"),
            )
            .hint("name a `limit` (up to the namespace maximum), or narrow with filters"));
        }
        Ok(Response {
            request_id: request_id.to_owned(),
            columns: plan.columns,
            rows,
        })
    }

    /// Plan without executing (`POST /{ns}/explain`).
    pub async fn explain(
        &self,
        namespace: &str,
        query: SemanticQuery,
        request_id: &str,
    ) -> Result<Explain, Failure> {
        let rt = self.runtime(namespace)?;
        let (plan, _) = self.plan(rt, query).await?;
        Ok(Explain {
            request_id: request_id.to_owned(),
            sql: plan.sql,
            columns: plan.columns,
            plan: plan.plan,
        })
    }
}

impl semantic_gate_sql::Backend for Gate {
    async fn metadata(&self, namespace: &str) -> Result<Metadata, Envelope> {
        Gate::metadata(self, namespace).map_err(|f| f.envelope(next_request_id()))
    }

    async fn query(&self, namespace: &str, query: SemanticQuery) -> Result<Response, Envelope> {
        let request_id = next_request_id();
        Gate::query(self, namespace, query, &request_id)
            .await
            .map_err(|f| f.envelope(request_id))
    }
}
