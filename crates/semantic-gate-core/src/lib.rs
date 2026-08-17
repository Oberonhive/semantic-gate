//! `semantic-gate-core` — the sans-io contract crate (brief §16.1, risk ⚠14).
//!
//! The types here are the shared contract between every future host of the
//! query pipeline — the Rust daemon today, and eventually a wasm32 host
//! running in a browser (tasks 0011/0016's duckdb-wasm spikes) — so this
//! crate carries a permanent law rather than a preference:
//!
//! - no `tokio`, or any other async runtime, as a dependency;
//! - no filesystem access;
//! - no clocks — no `std::time::SystemTime`/`Instant`; timestamps and
//!   `request_id` assignment are a host concern, not a contract-type concern
//!   (see `semantic_gate::server` for the daemon's `request_id` generator);
//! - no `Send` bound on any API here, ever, including a future async trait
//!   — that trait adopts a `MaybeSend`-style alias (unbounded on `wasm32`,
//!   `Send` elsewhere; reqwest's pattern) rather than a bare bound. No such
//!   alias exists yet: with zero async traits to bound, it would have zero
//!   callers.
//!
//! CI enforces the boundary mechanically —
//! `cargo build --target wasm32-unknown-unknown -p semantic-gate-core` — so a
//! violation is a compile failure, not a review comment.

pub mod error;

pub use error::{Envelope, ErrorCode};
