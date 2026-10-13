/**
 * @semantic-gate/viz — heuristic chart inference: semantic metadata + query +
 * response → a complete ECharts option.
 *
 * Pure and isomorphic: no DOM, no transport, no ECharts runtime. It runs in
 * the browser beside `@semantic-gate/client`, in the CLI, and anywhere else a
 * `Response` exists. The gate itself never draws (brief §13).
 *
 * ```text
 * shapeOf      metadata + query + response → Shape        fields.ts
 * chooseKind   Shape → kind, first-match table             rules.ts
 * encode       kind + Shape + query.viz → ChartSpec        encode.ts
 * toEcharts    ChartSpec + rows → option (JSON)            echarts.ts, format.ts
 * mergeOverride  query.viz.echarts, last                   echarts.ts
 * ```
 *
 * Hints come from `query.viz`. Prior art: biviz2 `semantic-core/src/infer`.
 */
import { mergeOverride, toEcharts, type Theme } from './echarts.ts';
import { encode } from './encode.ts';
import { shapeOf, type InferenceInput } from './fields.ts';
import { chooseKind } from './rules.ts';
import type { ChartSpec } from './spec.ts';

export type { DimensionField, InferenceInput, MeasureField, Shape } from './fields.ts';
export { REST_MEMBER } from './fields.ts';
export type { ChartKind, ChartSpec, Reason, TableColumn } from './spec.ts';
export type { FormatRef, FormatSpec } from './format.ts';
export { formatter, hydrate } from './format.ts';
export { REST_LABEL, type Theme } from './echarts.ts';
export { WORLD_MAP, worldRegion } from './geo.ts';
export { KIND_RULES, THRESHOLDS } from './rules.ts';

export interface Chart {
  /** The decisions, with reasons — for explaining, not for drawing. */
  spec: ChartSpec;
  /** JSON; `hydrate` it, then `setOption` (or render `spec.columns` as a table when `spec.kind === 'table'`). */
  option: Record<string, unknown>;
}

export function inferChart(input: InferenceInput, theme?: Theme): Chart {
  const hints = input.query.viz ?? {};
  const shape = shapeOf(input);
  const rule = chooseKind(shape);
  const spec = encode(hints.chart ?? rule.kind, shape, hints, rule.id);
  return { spec, option: mergeOverride(toEcharts(spec, shape, input.response, theme), hints.echarts) };
}
