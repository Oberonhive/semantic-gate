//! The answer to a semantic query. Mirrors `packages/contract/src/index.ts`.
//!
//! Columns carry their provenance — which metric, dimension, and modifier
//! produced them — as the provider declared it in its plan, so no consumer
//! parses a column name to learn what it holds.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::metadata::{TimeGrain, ValueType};

/// Rows plus what each column means.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Assigned by the host to every request (§9.1).
    pub request_id: String,
    /// One descriptor per column, in row order.
    pub columns: Vec<Column>,
    /// Row-major values; dates as `YYYY-MM-DD`, timestamps as RFC 3339.
    pub rows: Vec<Vec<Value>>,
}

/// One result column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Column {
    /// Wire name: the member's name, or `modifier(metric)`.
    pub name: String,
    /// Dimension or metric.
    pub role: Role,
    /// The declared metric or dimension this column derives from.
    pub member: String,
    /// The modifier that produced this column, when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifier: Option<String>,
    /// The value type.
    pub value_type: ValueType,
    /// The grain a time dimension was presented at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grain: Option<TimeGrain>,
}

/// Column roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// A grouping key.
    Dimension,
    /// An evaluated metric or a modifier output over one.
    Metric,
}

/// `POST /{ns}/explain`: what would run, without running it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Explain {
    /// Assigned by the host.
    pub request_id: String,
    /// The compiled statement.
    pub sql: String,
    /// The columns it returns.
    pub columns: Vec<Column>,
    /// The provider's own plan, for debugging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
}
