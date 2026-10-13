//! The provider host: spawns a namespace's cube provider, speaks the provider
//! protocol to it (`semantic-gate-core::protocol`), and keeps it alive.
//!
//! Own module because the process lifecycle (spawn, handshake, multiplexing,
//! restart with backoff) is a bounded problem that neither the pipeline nor
//! the REST surface should have to load. A provider that is not ready is a
//! state, not a startup failure: the supervisor keeps retrying and `/readyz`
//! reports the namespace until it succeeds.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use semantic_gate_core::ErrorCode;
use semantic_gate_core::metadata::Metadata;
use semantic_gate_core::protocol::{
    CONTRACT_VERSION, Dialect, InitializeParams, InitializeResult, Plan, PlanParams, ProviderError,
    REFUSAL_RPC_CODE,
};
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::failure::Failure;

/// `plan` must answer within this (`TIMEOUT_COMPILE`).
const PLAN_TIMEOUT: Duration = Duration::from_secs(10);
/// A node process starting up and compiling its cubes is allowed longer.
const START_TIMEOUT: Duration = Duration::from_secs(30);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

/// The part of `cubes.yaml` the host reads; the rest is the provider's.
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    entrypoint: Option<Vec<String>>,
}

struct RpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// One live stdio connection: requests multiplexed by id.
struct Rpc {
    outgoing: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    tasks: Vec<AbortHandle>,
}

impl Drop for Rpc {
    fn drop(&mut self) {
        self.tasks.iter().for_each(AbortHandle::abort);
    }
}

impl Rpc {
    async fn call<R: DeserializeOwned>(
        &self,
        method: &str,
        params: impl Serialize,
        timeout: Duration,
    ) -> Result<R, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if self.outgoing.send(line.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(exited());
        }
        let reply = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err(exited()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(Failure::new(
                    ErrorCode::TimeoutCompile,
                    format!(
                        "the provider did not answer `{method}` in {}s",
                        timeout.as_secs()
                    ),
                ));
            }
        };
        match reply {
            Ok(result) => serde_json::from_value(result).map_err(|e| {
                Failure::new(
                    ErrorCode::ProviderError,
                    format!("malformed `{method}` result from the provider: {e}"),
                )
            }),
            Err(error) if error.code == REFUSAL_RPC_CODE => {
                match error
                    .data
                    .and_then(|d| serde_json::from_value::<ProviderError>(d).ok())
                {
                    Some(refusal) => Err(Failure {
                        code: refusal.code,
                        message: refusal.message,
                        hint: refusal.hint,
                    }),
                    None => Err(Failure::new(ErrorCode::ProviderError, error.message)),
                }
            }
            Err(error) => Err(Failure::new(ErrorCode::ProviderError, error.message)),
        }
    }
}

fn exited() -> Failure {
    Failure::new(ErrorCode::ProviderError, "the provider process exited")
}

struct Live {
    rpc: Rpc,
    metadata: Metadata,
}

/// A namespace's provider, as the rest of the gate sees it.
pub struct Provider {
    name: String,
    cubes: PathBuf,
    dialect: Dialect,
    state: RwLock<State>,
}

#[derive(Default)]
struct State {
    live: Option<Arc<Live>>,
    last_error: Option<String>,
}

impl Provider {
    /// Start the supervisor and return at once; readiness arrives later.
    pub fn start(name: String, cubes: PathBuf, dialect: Dialect) -> Arc<Self> {
        let provider = Arc::new(Self {
            name,
            cubes,
            dialect,
            state: RwLock::default(),
        });
        tokio::spawn(Arc::clone(&provider).supervise());
        provider
    }

    /// Whether `plan` can be asked right now.
    pub fn ready(&self) -> bool {
        self.state.read().unwrap().live.is_some()
    }

    fn live(&self) -> Result<Arc<Live>, Failure> {
        let state = self.state.read().unwrap();
        state.live.clone().ok_or_else(|| {
            Failure::new(
                ErrorCode::ProviderError,
                format!("the provider for namespace {} is not ready", self.name),
            )
            .hint(state.last_error.clone().unwrap_or_default())
        })
    }

    /// What the namespace publishes.
    pub fn metadata(&self) -> Result<Metadata, Failure> {
        Ok(self.live()?.metadata.clone())
    }

    /// Ask the provider to compile `params`.
    pub async fn plan(&self, params: &PlanParams) -> Result<Plan, Failure> {
        self.live()?.rpc.call("plan", params, PLAN_TIMEOUT).await
    }

    async fn supervise(self: Arc<Self>) {
        let mut backoff = BACKOFF_MIN;
        loop {
            let reason = match self.run_once().await {
                (true, reason) => {
                    backoff = BACKOFF_MIN;
                    reason
                }
                (false, reason) => reason,
            };
            eprintln!(
                "[{}] provider unavailable: {reason}; retrying in {backoff:?}",
                self.name
            );
            {
                let mut state = self.state.write().unwrap();
                state.live = None;
                state.last_error = Some(reason);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }

    /// One process lifetime. Returns whether it ever became ready, and why it
    /// ended.
    async fn run_once(&self) -> (bool, String) {
        let started = Instant::now();
        let mut ready = false;
        let outcome: Result<(), String> = async {
            let manifest_path = self.cubes.join("cubes.yaml");
            let text = std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("{}: {e}", manifest_path.display()))?;
            let manifest: Manifest = serde_yaml_ng::from_str(&text)
                .map_err(|e| format!("{}: {e}", manifest_path.display()))?;
            let argv = manifest
                .entrypoint
                .filter(|argv| !argv.is_empty())
                .unwrap_or_else(|| vec!["semantic-gate-js".into(), "serve".into(), ".".into()]);

            let mut child = Command::new(&argv[0])
                .args(&argv[1..])
                .current_dir(&self.cubes)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("cannot start `{}`: {e}", argv[0]))?;

            let name = self.name.clone();
            let stderr = child.stderr.take().expect("piped");
            let log = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[{name}] {line}");
                }
            });
            let rpc = Rpc::attach(
                child.stdin.take().expect("piped"),
                child.stdout.take().expect("piped"),
            );

            let result = async {
                let init: InitializeResult = rpc
                    .call(
                        "initialize",
                        InitializeParams {
                            contract_version: CONTRACT_VERSION.to_owned(),
                        },
                        START_TIMEOUT,
                    )
                    .await
                    .map_err(|f| f.message)?;
                if init.contract_version != CONTRACT_VERSION {
                    return Err(format!(
                        "provider speaks contract {}, the gate {CONTRACT_VERSION}",
                        init.contract_version
                    ));
                }
                if !init.dialects.contains(&self.dialect) {
                    return Err(format!(
                        "the provider cannot emit {:?} SQL (it offers {:?})",
                        self.dialect, init.dialects
                    ));
                }
                let metadata: Value = rpc
                    .call("metadata", json!({}), START_TIMEOUT)
                    .await
                    .map_err(|f| f.message)?;
                let metadata: Metadata = serde_json::from_value(metadata)
                    .map_err(|e| format!("malformed metadata: {e}"))?;
                Ok(metadata)
            }
            .await;

            let metadata = match result {
                Ok(metadata) => metadata,
                Err(reason) => {
                    log.abort();
                    return Err(reason);
                }
            };
            let live = Arc::new(Live { rpc, metadata });
            {
                let mut state = self.state.write().unwrap();
                state.live = Some(Arc::clone(&live));
                state.last_error = None;
            }
            ready = true;
            eprintln!("[{}] provider ready", self.name);
            let status = child.wait().await;
            log.abort();
            Err(format!("the provider process ended ({status:?})"))
        }
        .await;
        let reason = outcome.err().unwrap_or_default();
        (ready && started.elapsed() > Duration::from_secs(5), reason)
    }
}

impl Rpc {
    /// Wire a child's pipes: one task writes lines, one reads and dispatches
    /// replies by id. When the child's stdout closes, every waiter is dropped
    /// and sees "exited".
    fn attach(stdin: tokio::process::ChildStdin, stdout: tokio::process::ChildStdout) -> Self {
        let pending: Pending = Arc::default();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<String>();
        let writer = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(mut line) = queue.recv().await {
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        let table = Arc::clone(&pending);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let Some(waiter) = table.lock().unwrap().remove(&id) else {
                    continue;
                };
                let reply = match message.get("error") {
                    Some(error) => Err(RpcError {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("provider error")
                            .to_owned(),
                        data: error.get("data").cloned(),
                    }),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = waiter.send(reply);
            }
            table.lock().unwrap().clear();
        });
        Self {
            outgoing,
            pending,
            next: AtomicU64::new(1),
            tasks: vec![writer.abort_handle(), reader.abort_handle()],
        }
    }
}
