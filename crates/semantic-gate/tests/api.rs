//! `env-service` scenario tests for `docs/spec/api.md`.
//!
//! `API-001`, `API-002`, and `API-003` describe what an operator or a
//! supervisor observes over HTTP and over the process's exit status, so
//! every scenario here drives the real binary rather than the router
//! directly.
#![cfg(feature = "env-service")]

mod common;

use std::process::Command;

/// API-001.S1 — a live gate answers healthz.
#[test]
fn api_001_s1_live_gate_answers_healthz() {
    let port = common::free_port();
    let gate = common::spawn_serving("api_001_s1", port, &common::minimal_config(port));

    let response = common::get(gate.port, "/healthz");

    assert_eq!(response.status, 200, "response: {response:?}");
    // Trimmed: the scenario fixes the body's content, not whether a
    // serializer appends a trailing newline.
    assert_eq!(response.body.trim(), r#"{"status":"ok"}"#);
}

/// API-002.S1 — a gate with no components is ready.
///
/// Task 0004's surface budget adds only `listen.http` (no namespace key
/// exists yet), so the minimal configuration already declares no
/// namespaces — there is no other configuration this scenario could mean.
#[test]
fn api_002_s1_gate_with_no_components_is_ready() {
    let port = common::free_port();
    let gate = common::spawn_serving("api_002_s1", port, &common::minimal_config(port));

    let response = common::get(gate.port, "/readyz");

    assert_eq!(response.status, 200, "response: {response:?}");
    assert_eq!(
        response.body.trim(),
        r#"{"status":"ready","components":[]}"#
    );
}

/// API-003.S1 — SIGTERM releases the port and exits zero.
#[test]
fn api_003_s1_sigterm_releases_port_and_exits_zero() {
    let port = common::free_port();
    let mut gate = common::spawn_serving("api_003_s1", port, &common::minimal_config(port));

    let kill_status = Command::new("kill")
        .arg("-TERM")
        .arg(gate.pid().to_string())
        .status()
        .expect("run `kill -TERM` against the gate");
    assert!(
        kill_status.success(),
        "`kill -TERM` itself failed: {kill_status}"
    );

    let exit = gate.wait_for_exit();
    assert_eq!(
        exit.code(),
        Some(0),
        "expected the gate to exit 0 on SIGTERM, got {exit}"
    );

    common::assert_port_free(port);
}
