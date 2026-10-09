/**
 * CubeModel — the declarative cube. A `.yaml` cube file *is* a serialised
 * `CubeModel`; the MetricFlow and cube.dev importers produce the same type;
 * `lower` turns it into the catalog facts every Datalog cube is made of. So
 * YAML, MetricFlow and cube.dev are restricted front-ends of the Datalog
 * method: whatever a CubeModel says, a fact says, and what it cannot say — a
 * new modifier's behaviour — it names as a Datalog rules file.
 *
 * SQL fragments are written in the cube's target dialect and reference the
 * fact table by its `alias` and joined tables by theirs. `{name}` holes are
 * parameters — the member's own, then the cube's `params` — or, in a
 * `derived` metric, other metrics: dependencies are declared, never guessed
 * by scanning SQL.
 *
 * ```yaml
 * cube: shop
 * table: orders
 * alias: o
 * params: {time_grain: month}
 * joins:
 *   customers: {table: customers, alias: c, on: o.customer_id = c.customer_id}
 * metrics:
 *   revenue:  {agg: sum, expr: o.revenue, display: {unit: USD, format: currency}}
 *   orders:   {agg: count}
 *   aov:      {derived: "{revenue} / nullif({orders}, 0)", display: {unit: USD, format: currency}}
 * dimensions:
 *   period:   {sql: "date_trunc('{time_grain}', o.order_date)", kind: time, grains: [day, week, month, quarter, year]}
 *   country:  {sql: o.country, kind: geo}
 *   segment:  {sql: c.segment, joins: [customers]}
 * ```
 */
import type {
  Additivity,
  DimensionDisplay,
  DimensionKind,
  Json,
  MetricDisplay,
  ModifierOutput,
  ParamSchema,
  TimeGrain,
  ValueType,
} from '@semantic-gate/contract';

export interface CubeModel {
  cube: string;
  /** Fact table: a table name or a parenthesised subquery. */
  table: string;
  /** Alias of the fact table in every fragment; default `o`. */
  alias?: string;
  description?: string;
  /** Constant filters, always applied. */
  where?: string[];
  /** Cube-level parameter defaults, the last step of the cascade. */
  params?: Record<string, Json>;
  joins?: Record<string, Join>;
  metrics: Record<string, Metric>;
  dimensions: Record<string, Dimension>;
  /** The cube's own modifiers. */
  modifiers?: Record<string, CubeModifier>;
}

export interface Join {
  table: string;
  alias: string;
  on: string | string[];
  /** Default `left`. */
  kind?: 'left' | 'inner';
  /** Joins this one needs first (snowflake chains). */
  requires?: string[];
}

interface MetricBase {
  description?: string;
  /** Default `number`. */
  value_type?: ValueType;
  /**
   * Required unless implied: `sum`/`count` → `additive`, `min`/`max` →
   * `mergeable`; `derived` and `two_stage` → `non_reaggregable`.
   */
  additivity?: Additivity;
  /** Joins every evaluation of this metric needs. */
  joins?: string[];
  params?: Record<string, ParamSchema>;
  display?: MetricDisplay;
}

/** `agg(expr)`; `count` without `expr` counts rows. `count_distinct` is `count(DISTINCT expr)`. */
export interface AggMetric extends MetricBase {
  agg: 'sum' | 'count' | 'count_distinct' | 'min' | 'max' | 'avg';
  expr?: string;
  /** Rows the aggregate considers; becomes `agg(expr) FILTER (WHERE …)` or the dialect's form. */
  filter?: string;
}

/** Any aggregate expression in the dialect. */
export interface SqlMetric extends MetricBase {
  sql: string;
}

/** A metric over metrics: `{revenue} / nullif({orders}, 0)`. */
export interface DerivedMetric extends MetricBase {
  derived: string;
}

/**
 * An aggregate over a per-entity aggregate: `outer` of (`inner` grouped by `entity`). `outer`
 * is a function prefix applied to the per-entity value (`avg`, `quantileExact(0.5)`), or a
 * template where `{v}` stands for it (`quantile_cont({v}, 0.5)`).
 */
export interface TwoStageMetric extends MetricBase {
  two_stage: { entity: string; inner: string; outer: string };
}

export type Metric = AggMetric | SqlMetric | DerivedMetric | TwoStageMetric;

export interface Dimension {
  sql: string;
  description?: string;
  /** Default `time` when `grains` is set, `category` otherwise. */
  kind?: DimensionKind;
  /** Default by kind: `date` for time, `string` otherwise. */
  value_type?: ValueType;
  grains?: TimeGrain[];
  joins?: string[];
  params?: Record<string, ParamSchema>;
  display?: DimensionDisplay;
}

/** A cube-declared modifier (MOD-001): the declaration is data, `rules` is its behaviour in Datalog. */
export interface CubeModifier {
  /**
   * Always 1 for a YAML cube: the hooks a cube's rules file can fill (`mod_cond`, a row condition
   * on the metric's aggregate, and `mod_wrap`, a reformat of it) express only class 1. Classes
   * 2-5 change rows or need neighbours, which takes plan stages the base vocabulary owns.
   */
  class: 1;
  output: ModifierOutput;
  description: string;
  params?: Record<string, ParamSchema>;
  /** Names of `params` a call must give. */
  required?: string[];
  /** Default: every additivity. */
  requires?: Additivity[];
  /** A `.dl` file, relative to the cube file. */
  rules: string;
}
