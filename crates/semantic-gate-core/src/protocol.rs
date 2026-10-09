//! The provider protocol — the one seam every authoring method plugs into
//! (brief §4). Mirrors `packages/contract/src/index.ts`, which is normative.
//!
//! JSON-RPC 2.0, one JSON message per line on stdio for a process; the gate
//! spawns the cube manifest's `entrypoint` and never learns how the provider
//! is written — semtrans (Datalog, YAML, MetricFlow, cube.dev) and free-form
//! TypeScript run under `semantic-gate-js serve`, free-form Python under its
//! own interpreter. Methods, in lifecycle order: `initialize`, `metadata`,
//! `plan` (per request), `shutdown`. A refusal is a JSON-RPC error with code
//! [`REFUSAL_RPC_CODE`] and [`ProviderError`] as `data`.

use serde::{Deserialize, Serialize};

use crate::error::ErrorCode;
use crate::query::{EvaluationContext, SemanticQuery};
use crate::response::Column;

/// The contract version this gate speaks.
pub const CONTRACT_VERSION: &str = "0.1";

/// JSON-RPC error code of a closed-taxonomy refusal.
pub const REFUSAL_RPC_CODE: i64 = -32000;

/// `initialize` parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitializeParams {
    /// The contract version the gate speaks.
    pub contract_version: String,
}

/// `initialize` result: properties of the provider, not of its cubes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitializeResult {
    /// The contract version the provider speaks.
    pub contract_version: String,
    /// SQL dialects `plan` can emit (⚠2).
    pub dialects: Vec<Dialect>,
}

/// `plan` parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanParams {
    /// The query, as the client sent it.
    pub query: SemanticQuery,
    /// Chosen by the gate from the namespace's datasource.
    pub dialect: Dialect,
    /// Fixed per request by the host (§3.1).
    pub context: EvaluationContext,
}

/// `plan` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    /// The statement to execute.
    pub sql: String,
    /// Exactly the columns the statement returns, in order.
    pub columns: Vec<Column>,
    /// The provider's own plan, for `explain`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<serde_json::Value>,
}

/// `data` of a refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    /// Closed code (§3.4).
    pub code: ErrorCode,
    /// Human-readable.
    pub message: String,
    /// What the caller could ask instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// SQL dialects a provider may target, one per connector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dialect {
    /// DuckDB — demos, conformance, local hosts (§16).
    Duckdb,
    /// ClickHouse — the first-priority warehouse.
    Clickhouse,
}
