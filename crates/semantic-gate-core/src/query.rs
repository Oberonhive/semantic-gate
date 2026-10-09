//! The semantic query — the closed request surface (brief §3.1, §3.3;
//! capability `QRY`, not yet specified).
//!
//! Every consumer reaches a gate with this one shape: REST sends it as JSON,
//! the SQL wire listener translates semantic SQL into it
//! (`semantic-gate-sql`), the JS client builds it directly. Every authoring
//! method receives it unchanged in `plan` (see [`crate::protocol`]). Nothing
//! here names a cube: the query is addressed to a namespace's vocabulary,
//! which [`crate::metadata::Metadata`] publishes. Mirrors
//! `packages/contract/src/index.ts`, which is normative.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::metadata::ChartKind;

/// A request for metrics, cut by dimensions, narrowed by filters, and
/// transformed by modifiers applied in array order (MOD-002).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticQuery {
    /// Metric names from the namespace's metadata.
    pub metrics: Vec<String>,
    /// Dimension names from the namespace's metadata.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimensions: Vec<String>,
    /// One filter tree; absent means unfiltered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Filter>,
    /// Applied in this order, after metric evaluation and before `order`
    /// (MOD-002). Order is semantics, not presentation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<ModifierCall>,
    /// Values for declared member parameters: `param` or `member.param`; the
    /// more specific key wins, then the declared default.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// Presentation order; never seen by a modifier (MOD-002).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<OrderBy>,
    /// Row cap; the namespace's `default_limit` applies when absent (§9.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// Presentation intent for chart inference; planning and execution ignore
    /// it, and the gate carries it so a query document stays self-contained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viz: Option<VizHints>,
}

/// Optional hints for chart inference; each pins one decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VizHints {
    /// Pin the chart kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<ChartKind>,
    /// Output column on the category/time axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    /// Output column whose members split series.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    /// Measure columns to draw, in order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<Vec<String>>,
    /// `none` | `stacked` | `percent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// `vertical` | `horizontal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// Chart title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Raw ECharts option merged last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echarts: Option<Map<String, Value>>,
}

/// A filter tree: boolean combinators over field predicates, unbounded
/// nesting, no raw SQL anywhere (§3.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Filter {
    /// `and` / `or` over any number of items; `not` over exactly one.
    Combine {
        /// The combinator.
        op: Logic,
        /// Its operands.
        items: Vec<Filter>,
    },
    /// A single predicate on a metric or a dimension.
    Predicate(Predicate),
}

/// Filter combinators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Logic {
    /// All items hold.
    And,
    /// Any item holds.
    Or,
    /// The single item does not hold.
    Not,
}

/// `field op value`. A predicate on a metric filters after aggregation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    /// A metric or dimension name.
    pub field: String,
    /// One of the closed operators.
    pub op: FilterOp,
    /// Scalar, array (`in`, `not_in`, `between`), or absent (`is_null`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

/// The closed filter-operator vocabulary (§3.3). Widening it is an owner
/// decision, never a design detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FilterOp {
    /// `=`
    #[serde(rename = "=")]
    Eq,
    /// `!=`
    #[serde(rename = "!=")]
    Ne,
    /// `>`
    #[serde(rename = ">")]
    Gt,
    /// `>=`
    #[serde(rename = ">=")]
    Ge,
    /// `<`
    #[serde(rename = "<")]
    Lt,
    /// `<=`
    #[serde(rename = "<=")]
    Le,
    /// Membership in a list.
    #[serde(rename = "in")]
    In,
    /// Non-membership in a list.
    #[serde(rename = "not_in")]
    NotIn,
    /// Inclusive range `[a, b]`.
    #[serde(rename = "between")]
    Between,
    /// Value is null.
    #[serde(rename = "is_null")]
    IsNull,
    /// Value is not null.
    #[serde(rename = "is_not_null")]
    IsNotNull,
    /// Substring match.
    #[serde(rename = "contains")]
    Contains,
    /// Prefix match.
    #[serde(rename = "starts_with")]
    StartsWith,
}

/// One modifier application: a declared name and parameters validated against
/// its declared schema (MOD-001).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModifierCall {
    /// A modifier declared in the namespace's metadata — base or cube, they
    /// are indistinguishable in a query (§3.2).
    pub name: String,
    /// Parameters, including the universe for classes 3–5.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

/// One presentation-order key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderBy {
    /// A metric, dimension, or modifier output column name.
    pub field: String,
    /// Direction.
    pub dir: Direction,
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Ascending.
    Asc,
    /// Descending.
    Desc,
}

/// The deterministic execution context (§3.1, §16.4): fixed per request by the
/// host, passed to `plan` and to execution, written to audit. Core never reads
/// a clock — the host injects this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationContext {
    /// RFC 3339 instant that "now" means for this request.
    pub evaluation_time: String,
    /// IANA zone name date truncation is performed in.
    pub timezone: String,
}
