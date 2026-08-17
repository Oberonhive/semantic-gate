//! semantic-gate — a thin serving layer between a data warehouse and its consumers.
//!
//! Behaviour arrives one specified capability at a time: a requirement in
//! `docs/spec/`, then a test derived from its scenario, then the code that makes
//! that test pass. See `CLAUDE.md` for the gates and `docs/spec/overview.md` for
//! what is specified so far.

pub mod config;
pub mod server;
