/**
 * Stage 1 — what each result column *is*.
 *
 * Three sources, none sufficient alone: metadata (dimension kind, metric
 * unit/format/additivity, a modifier column's declared class and output), the
 * response (column provenance, cardinality, label lengths, sign, the MOD-005
 * `__rest__` bucket), and the query (`viz.y` selects the measures drawn).
 *
 * Everything after this stage reads the `Shape` only, never metadata or
 * names: inference decides by declared class and output, so a cube's own
 * modifier charts exactly like the base modifier with the same output.
 */
import type {
  DimensionKind,
  Json,
  Metadata,
  ModifierOutput,
  NumberFormat,
  Response,
  SemanticQuery,
  TimeGrain,
} from '@semantic-gate/contract';

/** The collapsed remainder of a `topn`-like modifier (MOD-005): drawn last, in a neutral colour. */
export const REST_MEMBER = '__rest__';

export interface DimensionField {
  /** Column index in `response.rows`. */
  column: number;
  name: string;
  label: string;
  kind: DimensionKind;
  grain?: TimeGrain;
  /** Distinct values in this result, in first-appearance order. */
  members: Json[];
  cardinality: number;
  maxLabelLength: number;
  hasRest: boolean;
  /** `display.order`: leading members, in this order. */
  order: string[];
  /** `display.colors`: fixed colour per member. */
  colors: Record<string, string>;
}

export interface MeasureField {
  column: number;
  name: string;
  label: string;
  /** The metric the column derives from. */
  member: string;
  /** `value` is the metric itself; otherwise the producing modifier's declared output. */
  output: ModifierOutput | 'value';
  modifierClass?: 1 | 2 | 3 | 4 | 5;
  unit?: string;
  /** ISO currency code, when the format is currency and the unit is one. */
  currency?: string;
  format: NumberFormat;
  decimals?: number;
  integer: boolean;
  /** Additive metric and a summable output — the only measures a chart may stack. */
  stackable: boolean;
  goodWhen?: 'up' | 'down';
  color?: string;
  /** Negative values occur — a zero line applies. */
  signed: boolean;
}

/** The only input of every later stage. */
export interface Shape {
  /** Time dimensions first, then the response's order: `dims[0]` is the x-axis candidate. */
  dims: DimensionField[];
  measures: MeasureField[];
  rows: number;
  /** The query's `order` names an output column: the provider already ordered the rows. */
  ordered: string[];
}

export interface InferenceInput {
  metadata: Metadata;
  query: SemanticQuery;
  response: Response;
}

export function shapeOf({ metadata, query, response }: InferenceInput): Shape {
  const dimDecl = new Map(metadata.dimensions.map((d) => [d.name, d]));
  const metricDecl = new Map(metadata.metrics.map((m) => [m.name, m]));
  const modDecl = new Map(metadata.modifiers.map((m) => [m.name, m]));
  const dims: DimensionField[] = [];
  let measures: MeasureField[] = [];

  response.columns.forEach((col, column) => {
    const values = response.rows.map((r) => r[column] ?? null);
    if (col.role === 'dimension') {
      const decl = dimDecl.get(col.member);
      const members = [...new Set(values)];
      dims.push({
        column,
        name: col.name,
        label: decl?.display?.label ?? col.name,
        kind: decl?.kind ?? (col.grain || col.value_type === 'date' || col.value_type === 'timestamp' ? 'time' : 'category'),
        ...(col.grain && { grain: col.grain }),
        members,
        cardinality: members.length,
        maxLabelLength: Math.max(0, ...members.map((m) => String(m).length)),
        hasRest: members.includes(REST_MEMBER),
        order: (decl?.display?.order ?? []).map(String),
        colors: decl?.display?.colors ?? {},
      });
      return;
    }
    const metric = metricDecl.get(col.member);
    const mod = col.modifier ? modDecl.get(col.modifier) : undefined;
    const output = mod && mod.output !== 'rows' ? mod.output : 'value';
    const d = metric?.display;
    const label = d?.label ?? col.member;
    const unit = d?.unit;
    const format = d?.format ?? 'number';
    measures.push({
      column,
      name: col.name,
      label: col.modifier ? `${col.modifier}(${label})` : label,
      member: col.member,
      output,
      ...(mod && { modifierClass: mod.class }),
      ...(unit && output !== 'ratio' && output !== 'share' && output !== 'rank' && { unit }),
      ...(format === 'currency' && unit && /^[A-Z]{3}$/.test(unit) && { currency: unit }),
      format,
      ...(d?.decimals !== undefined && { decimals: d.decimals }),
      integer: col.value_type === 'integer',
      stackable: metric?.additivity === 'additive' && (output === 'value' || output === 'level'),
      ...(d?.good_when && { goodWhen: d.good_when }),
      ...(d?.color && { color: d.color }),
      signed: values.some((v) => typeof v === 'number' && v < 0),
    });
  });

  const y = query.viz?.y?.filter((n) => measures.some((m) => m.name === n));
  if (y?.length) measures = y.map((n) => measures.find((m) => m.name === n)!);

  // Stable: time first, the rest keep response order.
  dims.sort((a, b) => Number(b.kind === 'time') - Number(a.kind === 'time'));
  return { dims, measures, rows: response.rows.length, ordered: (query.order ?? []).map((o) => o.field) };
}
