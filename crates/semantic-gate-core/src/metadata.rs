//! Namespace metadata — the single source of truth about what a query may name
//! (brief §3.5; MOD-001), including the visualization hints chart inference
//! reads. Mirrors `packages/contract/src/index.ts`, which is normative.
//!
//! The gate never interprets these fields; it serves them as the provider
//! published them. They are typed here so that a provider publishing nonsense
//! is refused at start, not discovered by a client.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Everything a namespace publishes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    /// The contract version the provider speaks.
    pub contract_version: String,
    /// Identity of the definitions; lineage in every audit record (§10.1).
    pub cubes_sha: String,
    /// Declared metrics.
    pub metrics: Vec<MetricDecl>,
    /// Declared dimensions.
    pub dimensions: Vec<DimensionDecl>,
    /// Declared modifiers, base and cube alike.
    pub modifiers: Vec<ModifierDecl>,
}

/// One metric.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricDecl {
    /// Query-facing name.
    pub name: String,
    /// For agents and humans.
    pub description: String,
    /// The type of the evaluated value.
    pub value_type: ValueType,
    /// Decides which modifiers apply and whether a chart may stack it.
    pub additivity: Additivity,
    /// Dimensions this metric can be cut by.
    pub dimensions: Vec<String>,
    /// Declared parameters (JSON Schema subset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Visualization hints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Map<String, Value>>,
}

/// Metric additivity (§3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Additivity {
    /// Sums across every dimension.
    Additive,
    /// Sums across some dimensions, not across time.
    SemiAdditive,
    /// Not summable, but partial states merge.
    Mergeable,
    /// Neither summable nor mergeable.
    NonReaggregable,
}

/// One dimension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DimensionDecl {
    /// Query-facing name.
    pub name: String,
    /// For agents and humans.
    pub description: String,
    /// What the values are.
    pub kind: DimensionKind,
    /// The value type.
    pub value_type: ValueType,
    /// Grains a time dimension can be presented at.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grains: Vec<TimeGrain>,
    /// Declared parameters (JSON Schema subset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Visualization hints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Map<String, Value>>,
}

/// What a dimension's values are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionKind {
    /// Dates or instants.
    Time,
    /// Unordered labels.
    Category,
    /// Ordered numeric buckets.
    Number,
    /// Region codes a map can place.
    Geo,
    /// One row per business entity.
    Entity,
}

/// Time grains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeGrain {
    /// Calendar day.
    Day,
    /// ISO week.
    Week,
    /// Calendar month.
    Month,
    /// Calendar quarter.
    Quarter,
    /// Calendar year.
    Year,
}

/// Value types of metrics, dimensions, and result columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    /// Text.
    String,
    /// Whole numbers.
    Integer,
    /// Floating point or decimal.
    Number,
    /// True/false.
    Boolean,
    /// Calendar date, `YYYY-MM-DD` on the wire.
    Date,
    /// Instant, RFC 3339 on the wire.
    Timestamp,
}

/// Chart kinds, shared by query hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartKind {
    /// Line.
    Line,
    /// Area.
    Area,
    /// Bar.
    Bar,
    /// Pie.
    Pie,
    /// Scatter.
    Scatter,
    /// Heatmap.
    Heatmap,
    /// Map.
    Map,
    /// Single value.
    Kpi,
    /// Table.
    Table,
}

/// A modifier as the namespace declares it (MOD-001).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModifierDecl {
    /// Query-facing name.
    pub name: String,
    /// The class (1–5) every composition rule is decided by.
    pub class: u8,
    /// Parameter schema (MOD-001 subset).
    pub params: Value,
    /// Metric additivities it may apply to.
    pub requires: Vec<Additivity>,
    /// For agents and humans.
    pub description: String,
    /// `base` or `cube`.
    pub origin: Origin,
    /// What it does to its metric's values.
    pub output: ModifierOutput,
}

/// Where a declared modifier came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The contract's base vocabulary.
    Base,
    /// Declared by the cube.
    Cube,
}

/// The effect of a modifier on its metric's values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModifierOutput {
    /// Same unit as the metric.
    Level,
    /// Signed difference in the metric's unit.
    Difference,
    /// Signed dimensionless ratio.
    Ratio,
    /// Part of a whole, 0..1.
    Share,
    /// Ordinal position.
    Rank,
    /// No new column; the row set changes.
    Rows,
}
