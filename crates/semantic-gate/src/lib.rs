//! semantic-gate — a thin serving layer between a data warehouse and its consumers.
//!
//! The native host of the product (`docs/architecture.md`): configuration,
//! the provider host, DuckDB and ClickHouse connectors, one pipeline, and the
//! REST and SQL-wire surfaces over it.

pub mod calendar;
pub mod config;
pub mod connector;
pub mod failure;
pub mod pipeline;
pub mod provider;
pub mod server;
