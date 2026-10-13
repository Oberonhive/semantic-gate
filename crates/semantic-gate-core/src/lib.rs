//! `semantic-gate-core` — the contract types of the Rust gate (brief §3, §4).
//!
//! - [`query`] — the closed request surface, with member parameters and
//!   visualization hints;
//! - [`metadata`] — what a namespace publishes (§3.5, MOD-001), including the
//!   visualization hints chart inference reads;
//! - [`response`] — rows plus column provenance;
//! - [`protocol`] — the provider protocol (§4);
//! - [`error`] — the closed taxonomy and its envelope (§3.4).
//!
//! `packages/contract/src/index.ts` is the normative definition; these types
//! mirror it for the gate, and a difference is a bug here.
//!
//! The crate stays sans-io — no async runtime, no filesystem, no clocks, no
//! `Send` bounds — so that it keeps building for `wasm32-unknown-unknown`
//! (CI checks it). The local hosts of §16 no longer need it there: the
//! semantic runtime they embed is TypeScript (`docs/architecture.md`).

pub mod error;
pub mod metadata;
pub mod protocol;
pub mod query;
pub mod response;

pub use error::{Envelope, ErrorCode};
