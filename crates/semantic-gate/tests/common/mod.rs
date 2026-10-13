//! Shared harness for `env-service` scenario tests (task 0004).
//!
//! Every scenario in `docs/spec/cfg.md` and `docs/spec/api.md` covered here is
//! phrased at the process boundary — "the gate is started", "stderr names X",
//! "the port is free" — so this harness drives the real `semantic-gate` binary
//! over its CLI and a raw socket, never the library's internals. No HTTP
//! client dependency and no dev-dependencies at all: `std` only.
//!
//! Each test gets its own gate on its own ephemeral port and its own config
//! file under `target/`, so the suite is parallel-safe and never depends on
//! `./dev`'s instance or `dev.yaml` (see `CLAUDE.md`, "The loop").
//!
//! `cfg.rs`, `api.rs`, and `err.rs` each compile as their own crate against
//! this module, so a helper only one of them calls is genuinely `dead_code`
//! in the others' binaries. Those are marked `#[allow(dead_code)]` at the
//! item, each noting which file needs it — not a blanket allow, so a helper
//! no file calls would still be caught.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// How long a test waits for the gate to come up, to go down, or to exit
/// after a refused configuration, before giving up. Chosen generously for a
/// debug build under load; a real hang is reported with the child's stderr,
/// not a bare timeout.
const DEADLINE: Duration = Duration::from_secs(10);

/// Spacing between polls of the child's state or the socket.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Bind an ephemeral port, read it back, and release it immediately so the
/// child under test can bind it. There is an inherent, tiny race between
/// releasing the port here and the child binding it; scenarios in this suite
/// never share a port, so two tests cannot lose that race to each other.
pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind an ephemeral port")
        .local_addr()
        .expect("read back the bound ephemeral port")
        .port()
}

/// The minimal valid configuration (`CFG-001.S1`'s example, with the literal
/// `7777` replaced by a freshly allocated port so every test owns its own).
pub(crate) fn minimal_config(port: u16) -> String {
    format!("listen:\n  http: 127.0.0.1:{port}\n")
}

/// A config file written under `target/tmp/env-service/`, removed with its
/// directory when dropped. `name` is the scenario id so directories never
/// collide between the scenarios in this suite; `std::process::id()` keeps a
/// leftover from a run that bypassed `Drop` (e.g. a `SIGKILL`ed harness) from
/// colliding with the next run.
struct ConfigFile {
    dir: PathBuf,
    path: PathBuf,
}

impl Drop for ConfigFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn write_config(name: &str, yaml: &str) -> ConfigFile {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/tmp/env-service")
        .join(format!("{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create the test's config directory under target/");
    let path = dir.join("semantic-gate.yaml");
    fs::write(&path, yaml).expect("write the test's config file");
    ConfigFile { dir, path }
}

fn command(config_path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_semantic-gate"));
    command
        .args(["serve", "--config"])
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Read a child's stderr to EOF. Only meaningful once the child has exited
/// (or been killed and waited on): reading from a live child's pipe here
/// would risk blocking on a process that is still writing.
fn read_stderr(child: &mut Child) -> String {
    let mut buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut buf);
    }
    buf
}

/// A running `semantic-gate` gate, spawned by [`spawn_serving`]. Killed on drop
/// — including when the test panics — so a failing run never leaves a
/// daemon behind.
pub(crate) struct Gate {
    child: Child,
    pub(crate) port: u16,
    _config: ConfigFile,
}

impl Drop for Gate {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// `pid` and `wait_for_exit` are called only by `api.rs`'s `API-003.S1`
// (SIGTERM); `cfg.rs` never signals a gate. See the module doc comment.
#[allow(dead_code)]
impl Gate {
    /// The child's OS process id, for signalling it.
    pub(crate) fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Poll for the child's exit against [`DEADLINE`], panicking with its
    /// pid if it is still alive when that elapses (and killing it, so the
    /// panic doesn't itself leak a daemon).
    pub(crate) fn wait_for_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + DEADLINE;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll the gate's exit status") {
                return status;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                panic!(
                    "gate (pid {}) did not exit within {DEADLINE:?} after being signalled",
                    self.child.id()
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

/// Spawn `semantic-gate serve --config <path>` with `config_yaml` written under
/// `target/`, and wait for it to accept a connection on `port`. Panics with
/// the child's captured stderr if it exits early or never comes up before
/// the deadline — a timeout here must say why the process did not start.
pub(crate) fn spawn_serving(name: &str, port: u16, config_yaml: &str) -> Gate {
    let config = write_config(name, config_yaml);
    let mut child = command(&config.path)
        .spawn()
        .expect("spawn the semantic-gate binary");

    let deadline = Instant::now() + DEADLINE;
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Gate {
                child,
                port,
                _config: config,
            };
        }
        if let Some(status) = child.try_wait().expect("poll the gate's exit status") {
            panic!(
                "{name}: gate exited ({status}) before 127.0.0.1:{port} accepted a \
                 connection; stderr:\n{}",
                read_stderr(&mut child)
            );
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "{name}: gate did not accept a connection on 127.0.0.1:{port} within \
                 {DEADLINE:?}; stderr:\n{}",
                read_stderr(&mut child)
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// The outcome of a gate expected to refuse to start: its exit status and
/// everything it wrote to stderr.
///
/// Built and read only by `cfg.rs`'s refused-startup scenarios; `api.rs`
/// never expects a refusal. See the module doc comment.
#[allow(dead_code)]
pub(crate) struct Refused {
    pub(crate) status: ExitStatus,
    pub(crate) stderr: String,
}

// Called only by `spawn_refused` and `spawn_refused_missing` below, both
// `cfg.rs`-only; see [`Refused`].
#[allow(dead_code)]
fn spawn_refused_at(config_path: &Path) -> Refused {
    let mut child = command(config_path)
        .spawn()
        .expect("spawn the semantic-gate binary");

    let deadline = Instant::now() + DEADLINE;
    loop {
        if let Some(status) = child.try_wait().expect("poll the gate's exit status") {
            return Refused {
                status,
                stderr: read_stderr(&mut child),
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "gate did not exit within {DEADLINE:?} for a configuration that should \
                 have been refused at startup; stderr:\n{}",
                read_stderr(&mut child)
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Spawn `semantic-gate serve --config <path>` with `config_yaml` written under
/// `target/`, and wait for it to exit — for scenarios where a bad
/// configuration must stop startup. The config's directory is removed when
/// this returns.
///
/// Called only by `cfg.rs`; see [`Refused`].
#[allow(dead_code)]
pub(crate) fn spawn_refused(name: &str, config_yaml: &str) -> Refused {
    let config = write_config(name, config_yaml);
    spawn_refused_at(&config.path)
}

/// Like [`spawn_refused`], but for a config path the test does not create
/// (`CFG-001.S4`'s missing-file scenario): no directory is written or
/// removed.
///
/// Called only by `cfg.rs`; see [`Refused`].
#[allow(dead_code)]
pub(crate) fn spawn_refused_missing(config_path: &str) -> Refused {
    spawn_refused_at(Path::new(config_path))
}

/// Assert nothing is listening on `port` — used after a refused or completed
/// shutdown to prove the gate isn't holding it. Retries briefly: a listening
/// socket is released as soon as the process's file descriptors are, but the
/// harness's own `wait()` returning is not a guarantee the kernel has
/// finished that teardown on every scheduler tick.
///
/// Called only by `cfg.rs` and `api.rs`; `err.rs` never stops its gate. See
/// the module doc comment.
#[allow(dead_code)]
pub(crate) fn assert_port_free(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                drop(listener);
                return;
            }
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                panic!("expected 127.0.0.1:{port} to be free, but bind failed: {error}")
            }
        }
    }
}

/// A parsed HTTP/1.1 response: status code and body. Headers are not kept —
/// no scenario in this suite asserts on one.
#[derive(Debug)]
pub(crate) struct HttpResponse {
    pub(crate) status: u16,
    // Read by `api.rs` (`API-001.S1`, `API-002.S1`) and `err.rs`
    // (`ERR-001.S1`, `ERR-001.S2`); `cfg.rs`'s `CFG-001.S1` asserts only
    // `status` (see that test's doc comment). See the module doc comment.
    #[allow(dead_code)]
    pub(crate) body: String,
}

/// Send `request` (a complete HTTP/1.1 request, method line through its
/// trailing blank line) over a fresh connection to `127.0.0.1:<port>`, read
/// to EOF, then split status line / headers / body. Shared by [`get`] and
/// [`post`] — the only two HTTP methods this suite speaks; no HTTP client
/// dependency is taken for either (task 0004). A first line that doesn't open
/// with an HTTP version token (`HTTP/1.`) is not credited with a status:
/// `status` stays `0`, the same sentinel used when the line has no second
/// token at all or that token doesn't parse as a number.
fn send(port: u16, request: &str) -> HttpResponse {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .unwrap_or_else(|error| panic!("connect to 127.0.0.1:{port}: {error}"));
    stream
        .set_read_timeout(Some(DEADLINE))
        .expect("set read timeout");
    stream
        .write_all(request.as_bytes())
        .unwrap_or_else(|error| panic!("write request to 127.0.0.1:{port}: {error}"));

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .unwrap_or_else(|error| panic!("read the response from 127.0.0.1:{port}: {error}"));
    let raw = String::from_utf8_lossy(&raw);

    let mut sections = raw.splitn(2, "\r\n\r\n");
    let head = sections.next().unwrap_or_default();
    let body = sections.next().unwrap_or_default().to_string();
    let status_line = head.lines().next().unwrap_or_default();
    let status = status_line
        .starts_with("HTTP/1.")
        .then(|| status_line.split_whitespace().nth(1))
        .flatten()
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);

    HttpResponse { status, body }
}

/// `GET <path>` against `127.0.0.1:<port>`, `Connection: close`. See
/// [`send`].
///
/// Called only by `cfg.rs` and `api.rs`; `err.rs`'s `ERR-001` scenarios only
/// `POST`. See the module doc comment.
#[allow(dead_code)]
pub(crate) fn get(port: u16, path: &str) -> HttpResponse {
    send(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    )
}

/// `POST <path>` with an `application/json` `body` against
/// `127.0.0.1:<port>`, `Connection: close`. See [`send`].
///
/// Called only by `err.rs`'s `ERR-001` scenarios; see the module doc comment.
#[allow(dead_code)]
pub(crate) fn post(port: u16, path: &str, body: &str) -> HttpResponse {
    send(
        port,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        ),
    )
}
