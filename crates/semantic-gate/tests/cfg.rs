//! `env-service` scenario tests for `docs/spec/cfg.md`.
//!
//! `CFG-001` and `CFG-002` are phrased at the process boundary — exit
//! status, stderr, whether a port ends up bound — so every scenario here
//! spawns the real binary rather than calling `Config::load` directly.
#![cfg(feature = "env-service")]

mod common;

/// CFG-001.S1 — a valid minimal configuration starts the service.
///
/// The bind is proven by `spawn_serving`'s readiness poll succeeding.
/// "Serves requests" is proven here by getting a syntactically valid HTTP
/// response back over that same connection; the scenario names no route or
/// status code, so the response's specific contents are `API-001`/`API-002`'s
/// job, not this one's.
#[test]
fn cfg_001_s1_valid_minimal_config_starts_the_service() {
    let port = common::free_port();
    let gate = common::spawn_serving("cfg_001_s1", port, &common::minimal_config(port));

    let response = common::get(gate.port, "/");
    assert!(
        (100..600).contains(&response.status),
        "expected a syntactically valid HTTP response (a status line with a \
         plausible 3-digit code) from a serving gate, got: {response:?}"
    );
}

/// CFG-001.S2 — an unknown key is refused by name.
#[test]
fn cfg_001_s2_unknown_key_is_refused_by_name() {
    let port = common::free_port();
    let config = format!("listen:\n  http: 127.0.0.1:{port}\nnamesapce: {{}}\n");
    let refused = common::spawn_refused("cfg_001_s2", &config);

    assert!(
        !refused.status.success(),
        "expected a non-zero exit, got {}",
        refused.status
    );
    assert!(
        refused.stderr.contains("namesapce"),
        "expected stderr to name `namesapce`, got:\n{}",
        refused.stderr
    );
    assert!(
        refused.stderr.to_lowercase().contains("unknown"),
        "expected stderr to state `namesapce` is unknown, got:\n{}",
        refused.stderr
    );
    common::assert_port_free(port);
}

/// CFG-001.S3 — a value of the wrong shape is refused by key.
///
/// The scenario's example value (`7777`) is a bare port number where a
/// socket address is required; the point under test is the shape, not that
/// specific number, so a freshly allocated port is substituted in its place
/// to keep the check parallel-safe like every other scenario here.
#[test]
fn cfg_001_s3_wrong_shape_value_is_refused_by_key() {
    let port = common::free_port();
    let config = format!("listen:\n  http: {port}\n");
    let refused = common::spawn_refused("cfg_001_s3", &config);

    assert!(
        !refused.status.success(),
        "expected a non-zero exit, got {}",
        refused.status
    );
    assert!(
        refused.stderr.contains("listen.http"),
        "expected stderr to name `listen.http`, got:\n{}",
        refused.stderr
    );
    assert!(
        refused.stderr.to_lowercase().contains("socket address"),
        "expected stderr to state that a socket address was expected, got:\n{}",
        refused.stderr
    );
    common::assert_port_free(port);
}

/// CFG-001.S4 — a missing file is refused by path.
#[test]
fn cfg_001_s4_missing_file_is_refused_by_path() {
    const PATH: &str = "/nonexistent/semantic-gate.yaml";
    assert!(
        !std::path::Path::new(PATH).exists(),
        "precondition violated: {PATH} exists on this machine"
    );

    let refused = common::spawn_refused_missing(PATH);

    assert!(
        !refused.status.success(),
        "expected a non-zero exit, got {}",
        refused.status
    );
    assert!(
        refused.stderr.contains(PATH),
        "expected stderr to name {PATH}, got:\n{}",
        refused.stderr
    );
}

/// CFG-002.S1 — an absent listen address is refused by name.
#[test]
fn cfg_002_s1_absent_listen_address_is_refused_by_name() {
    let refused = common::spawn_refused("cfg_002_s1", "{}\n");

    assert!(
        !refused.status.success(),
        "expected a non-zero exit, got {}",
        refused.status
    );
    assert!(
        refused.stderr.contains("listen"),
        "expected stderr to name `listen`, got:\n{}",
        refused.stderr
    );
}
