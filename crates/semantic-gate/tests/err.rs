//! `env-service` scenario tests for `docs/spec/err.md`.
//!
//! `ERR-001` is phrased entirely at the HTTP boundary — status code, JSON
//! envelope shape, `request_id` identity — so every scenario here drives the
//! real binary rather than a router or handler directly.
#![cfg(feature = "env-service")]

mod common;

/// Extract the string value of `"key":"..."` from a JSON object's raw text.
/// Enough for the closed envelope's flat `{code, message, request_id, hint?}`
/// shape (`docs/spec/err.md`) without taking a JSON dependency in this
/// dependency-free suite (`docs/spec/environments.md`, `env-service`). Not a
/// general JSON parser — it assumes no escaped quote inside the value, true
/// for every value this envelope produces today.
fn json_string_field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle)? + needle.len();
    let end = start + body[start..].find('"')?;
    Some(&body[start..end])
}

/// Whether `body` has a top-level `"key":` — used for `hint`, which is
/// present only when the gate has something to suggest and so cannot be
/// checked with [`json_string_field`] (`Option::None` alone wouldn't
/// distinguish "absent" from "present with a non-string value").
fn has_json_key(body: &str, key: &str) -> bool {
    body.contains(&format!("\"{key}\":"))
}

/// ERR-001.S1 — unknown namespace.
#[test]
fn err_001_s1_unknown_namespace_returns_ns_not_found() {
    let port = common::free_port();
    // The minimal configuration declares no namespace key at all (see
    // `cfg.rs`'s `CFG-001.S1` and `api.rs`'s `API-002.S1` doc comments), which
    // is this scenario's "no namespace exists".
    let gate = common::spawn_serving("err_001_s1", port, &common::minimal_config(port));

    let response = common::post(gate.port, "/nosuch/query", "{}");

    assert_eq!(response.status, 404, "response: {response:?}");

    assert_eq!(
        json_string_field(&response.body, "code"),
        Some("ns_not_found"),
        "expected code \"ns_not_found\", got response: {response:?}"
    );

    let message = json_string_field(&response.body, "message");
    assert!(
        message.is_some_and(|message| message.contains("nosuch")),
        "expected message to contain \"nosuch\", got response: {response:?}"
    );

    let request_id = json_string_field(&response.body, "request_id");
    assert!(
        request_id.is_some_and(|id| !id.is_empty()),
        "expected a non-empty request_id, got response: {response:?}"
    );

    assert!(
        !has_json_key(&response.body, "hint"),
        "expected no `hint` key when no namespaces exist, got response: {response:?}"
    );
}

/// ERR-001.S2 — request identity.
#[test]
fn err_001_s2_request_identity() {
    let port = common::free_port();
    let gate = common::spawn_serving("err_001_s2", port, &common::minimal_config(port));

    let first = common::post(gate.port, "/nosuch/query", "{}");
    let second = common::post(gate.port, "/nosuch/query", "{}");

    let first_id = json_string_field(&first.body, "request_id");
    assert!(
        first_id.is_some_and(|id| !id.is_empty()),
        "expected the first response to carry a non-empty request_id, got: {first:?}"
    );
    let second_id = json_string_field(&second.body, "request_id");
    assert!(
        second_id.is_some_and(|id| !id.is_empty()),
        "expected the second response to carry a non-empty request_id, got: {second:?}"
    );

    assert_ne!(
        first_id, second_id,
        "expected the two request_ids to differ, got the same value for both"
    );
}
