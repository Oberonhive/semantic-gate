/**
 * @semantic-gate/contract — the semantic-gate contract, normative.
 *
 * One query shape, one metadata shape, one result shape, one provider
 * protocol — the same in every host (native gate, node, browser) and for
 * every authoring method (Datalog, YAML, MetricFlow, cube.dev, free-form
 * TypeScript, free-form Python). `crates/semantic-gate-core` mirrors these
 * types for the Rust gate and `python/semantic-gate-provider` for Python
 * providers; where they differ, this file is right.
 *
 * Wire names are snake_case and every optional field is omitted, never
 * `null`.
 */

export const CONTRACT_VERSION = '0.1';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ================================================================ query (brief §3.1, §3.3)

/** A request for metrics, cut by dimensions, narrowed by filters, transformed by modifiers. */
export interface SemanticQuery {
  metrics: string[];
  dimensions?: string[];
  filters?: Filter;
  /** Applied in array order, after metric evaluation, before `order` and `limit` (MOD-002). */
  modifiers?: ModifierCall[];
  /**
   * Values for declared member parameters. A key is `param` (every member
   * declaring it) or `member.param` (that member only); the more specific
   * key wins, then the declared default. Unknown keys are `invalid_params`.
   */
  params?: Record<string, Json>;
  order?: OrderBy[];
  limit?: number;
  /**
   * Presentation intent for chart inference. Planning and execution ignore
   * it; it travels with the query so a query document is self-contained.
   */
  viz?: VizHints;
}

export type Filter = { op: 'and' | 'or' | 'not'; items: Filter[] } | Predicate;

export interface Predicate {
  /** A dimension (filters before aggregation) or a metric (filters after). */
  field: string;
  op: FilterOp;
  /** Scalar; array for `in`, `not_in` and `between` (`[low, high]`, inclusive); absent for `is_null`, `is_not_null`. */
  value?: Json;
}

/** The closed operator vocabulary (§3.3). */
export type FilterOp =
  | '=' | '!=' | '>' | '>=' | '<' | '<='
  | 'in' | 'not_in' | 'between' | 'is_null' | 'is_not_null'
  | 'contains' | 'starts_with';

export interface ModifierCall {
  name: string;
  params?: Record<string, Json>;
}

export interface OrderBy {
  /** Any output column name: a dimension, a metric, or a modifier output such as `delta_pct(revenue)`. */
  field: string;
  dir: 'asc' | 'desc';
}

/** Optional hints for chart inference. Each pins one decision; inference makes the rest around it. */
export interface VizHints {
  chart?: ChartKind;
  /** Output column on the category/time axis. */
  x?: string;
  /** Output column whose members split series. */
  series?: string;
  /** Measure columns to draw, in order; default: every metric column. */
  y?: string[];
  stack?: 'none' | 'stacked' | 'percent';
  orientation?: 'vertical' | 'horizontal';
  title?: string;
  /** Raw ECharts option merged last: objects by key, arrays by index. */
  echarts?: Record<string, Json>;
}

export type ChartKind = 'line' | 'area' | 'bar' | 'pie' | 'scatter' | 'heatmap' | 'map' | 'kpi' | 'table';

/** Fixed per request by the host; passed to `plan` (§3.1, §16.4). */
export interface EvaluationContext {
  /** RFC 3339 instant that "now" means for this request. */
  evaluation_time: string;
  /** IANA zone date truncation happens in. */
  timezone: string;
}

// ================================================================ metadata (brief §3.5, MOD-001)

/** Everything a namespace publishes. What is not here does not exist for a query. */
export interface Metadata {
  contract_version: string;
  /** Identity of the definitions: a commit for a cubes repository, a content hash otherwise. */
  cubes_sha: string;
  metrics: MetricDecl[];
  dimensions: DimensionDecl[];
  modifiers: ModifierDecl[];
}

export interface MetricDecl {
  name: string;
  description: string;
  value_type: ValueType;
  additivity: Additivity;
  /** Dimensions this metric can be cut by. */
  dimensions: string[];
  params?: ParamsSchema;
  display?: MetricDisplay;
}

export type Additivity = 'additive' | 'semi_additive' | 'mergeable' | 'non_reaggregable';

export interface DimensionDecl {
  name: string;
  description: string;
  kind: DimensionKind;
  value_type: ValueType;
  /** Time dimensions: grains the values can be presented at. */
  grains?: TimeGrain[];
  params?: ParamsSchema;
  display?: DimensionDisplay;
}

export type DimensionKind = 'time' | 'category' | 'number' | 'geo' | 'entity';
export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ValueType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'timestamp';

/** Visualization hints a cube author declares once, so no consumer guesses them. */
export interface MetricDisplay {
  /** Human title; default: the name. */
  label?: string;
  /** Suffix or ISO currency code. Two units in one chart give two value axes. */
  unit?: string;
  format?: NumberFormat;
  /** Fraction digits; default by format. */
  decimals?: number;
  /** Which direction of change is good; colours deltas. */
  good_when?: 'up' | 'down';
  /** Fixed series colour. */
  color?: string;
}

export type NumberFormat = 'number' | 'percent' | 'currency' | 'duration';

export interface DimensionDisplay {
  label?: string;
  /** Ordinal order of members; unlisted members follow in natural order. */
  order?: Json[];
  /** Fixed colour per member. */
  colors?: Record<string, string>;
}

export interface ModifierDecl {
  name: string;
  /** 1 reformat · 2 neighbour on a date axis · 3 whole result · 4 outside the window · 5 regrain */
  class: 1 | 2 | 3 | 4 | 5;
  params: ParamsSchema;
  /** Metric additivities it may apply to. */
  requires: Additivity[];
  description: string;
  origin: 'base' | 'cube';
  /** What it does to its metric's values — chart inference decides by this, never by name. */
  output: ModifierOutput;
}

/**
 * `level` same unit as the metric (prev_value, rolling, cumulative) ·
 * `difference` signed, metric's unit (delta_abs) · `ratio` signed,
 * dimensionless (delta_pct) · `share` part of a whole, 0..1 · `rank` ordinal
 * · `rows` no new column, the row set changes (topn).
 */
export type ModifierOutput = 'level' | 'difference' | 'ratio' | 'share' | 'rank' | 'rows';

/** The MOD-001 JSON Schema subset, plus `default` and `description` annotations. */
export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSchema>;
  required?: string[];
}

export interface ParamSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
  default?: Json;
  description?: string;
}

// ================================================================ result

export interface Response {
  request_id: string;
  columns: Column[];
  /** Row-major; dates as `YYYY-MM-DD`, timestamps as RFC 3339. */
  rows: Json[][];
}

export interface Column {
  /** Wire name: the member's name, or `modifier(metric)` for a modifier output. */
  name: string;
  role: 'dimension' | 'metric';
  /** The declared metric or dimension the column derives from. */
  member: string;
  /** The modifier that produced the column, when one did. */
  modifier?: string;
  value_type: ValueType;
  /** The grain a time dimension was presented at. */
  grain?: TimeGrain;
}

export interface Explain {
  request_id: string;
  sql: string;
  columns: Column[];
  /** The provider's own plan, for debugging; shape is the provider's. */
  plan?: Json;
}

// ================================================================ provider protocol (brief §4)

/**
 * JSON-RPC 2.0. Carrier: one JSON message per line on stdio for a process
 * (the native gate, any language), or a direct call for an in-process
 * provider (node and browser hosts). Methods:
 *
 * - `initialize(InitializeParams) → InitializeResult` — first call;
 * - `metadata() → Metadata` — the cube's surface, stable for the process;
 * - `plan(PlanParams) → Plan` — compile one query; never executes;
 * - `shutdown() → null` — the provider exits after answering.
 *
 * A refusal is a JSON-RPC error with `code: -32000` and `data: ProviderError`.
 */
export interface Provider {
  initialize(params: InitializeParams): InitializeResult | Promise<InitializeResult>;
  metadata(): Metadata | Promise<Metadata>;
  plan(params: PlanParams): Plan | Promise<Plan>;
}

export interface InitializeParams {
  contract_version: string;
}

/** Properties of the provider, not of its cubes (§4). */
export interface InitializeResult {
  contract_version: string;
  dialects: Dialect[];
}

export type Dialect = 'duckdb' | 'clickhouse';

export interface PlanParams {
  query: SemanticQuery;
  dialect: Dialect;
  context: EvaluationContext;
}

export interface Plan {
  sql: string;
  /** Exactly the columns the SQL returns, in order. */
  columns: Column[];
  plan?: Json;
}

/** `data` of a JSON-RPC refusal. */
export interface ProviderError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

/** Thrown by an in-process provider; becomes the JSON-RPC error over stdio. */
export class Refusal extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const REFUSAL_RPC_CODE = -32000;

/** Identity at runtime; gives a free-form author the interface check at the definition site. */
export function defineProvider(provider: Provider): Provider {
  return provider;
}

// ================================================================ cubes manifest (brief §5)

/**
 * `cubes.yaml` at the root of a cube directory: how any host obtains its
 * provider. Exactly one of `semtrans`, `module`, `entrypoint` decides the kind.
 */
export interface CubesManifest {
  contract: string;
  /** A semtrans cube set: sources compiled, in order, into one Datalog program. */
  semtrans?: CubeSource[];
  /** A free-form TypeScript provider: a module whose default export is a `Provider`. */
  module?: string;
  /**
   * The process the native gate spawns (cwd = this directory). Default for
   * `semtrans` and `module`: `[semantic-gate-js, serve, .]`. Alone, it is a
   * process-only provider (free-form Python) that local hosts cannot run.
   */
  entrypoint?: string[];
  /**
   * Local hosts: table name → data file or URL, relative to this file — `.csv`,
   * `.parquet`, or an Iceberg table as its `metadata.json` or its directory.
   */
  tables?: Record<string, string>;
}

/** A `.yaml` cube (CubeModel), a `.dl` cube, or a foreign model to import. */
export type CubeSource = string | { metricflow: string } | { cubedev: string };

// ================================================================ errors (brief §3.4)

export type ErrorCode =
  | 'unknown_metric' | 'unknown_dimension' | 'unknown_modifier'
  | 'invalid_params' | 'invalid_composition' | 'non_additive_violation'
  | 'filter_op_not_allowed' | 'result_too_large'
  | 'timeout_compile' | 'timeout_execute'
  | 'upstream_auth_failed' | 'upstream_unavailable'
  | 'ns_not_found' | 'token_invalid' | 'token_revoked' | 'rate_limited'
  | 'provider_error' | 'internal';

/** Every refusal any host returns. */
export interface Envelope {
  code: ErrorCode;
  message: string;
  request_id: string;
  hint?: string;
}
