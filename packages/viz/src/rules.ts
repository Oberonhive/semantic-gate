/**
 * Stage 2 — which chart. A first-match table over the `Shape`, not a score:
 * a table can be read top to bottom and its winner named in `reasons`.
 *

 * Ported from biviz2 (`semantic-core/src/infer/shape.ts` RULES), plus the
 * rules only a semantic layer can afford — they key on a modifier's declared
 * output, which biviz2 never had. Pie, area and table are reachable by
 * rule or by hint; a rule never guesses one the shape does not justify.
 */
import type { Shape } from './fields.ts';
import type { ChartKind } from './spec.ts';

/** Every number a heuristic compares against, in one place. */
export const THRESHOLDS = {
  /** More members than this on a category axis turns bars horizontal (biviz2). */
  horizontalAbove: 12,
  /** A label longer than this turns bars horizontal (biviz2). */
  longLabel: 16,
  /** A time series split by more members than this stops being lines. */
  maxLineSeries: 10,
  /** Both dimensions above this many members make a heatmap. */
  heatmapAbove: 5,
  /** A share over at most this many members is a pie. */
  maxPieSlices: 6,
  /** A time axis with more points than this gets `dataZoom`. */
  zoomAbove: 60,
  /** Distinct units beyond this many share an axis rather than add one. */
  maxValueAxes: 2,
} as const;

export interface Rule {
  id: string;
  kind: ChartKind;
  when(shape: Shape): boolean;
}

export const KIND_RULES: readonly Rule[] = [
  { id: 'single-value', kind: 'kpi', when: (s) => s.rows <= 1 },
  { id: 'wide-result', kind: 'table', when: (s) => s.dims.length > 2 },
  {
    id: 'share-of-few',
    kind: 'pie',
    when: (s) =>
      s.dims.length === 1 &&
      s.dims[0]?.kind === 'category' &&
      s.measures.length === 1 &&
      s.measures[0]?.output === 'share' &&
      s.dims[0].cardinality <= THRESHOLDS.maxPieSlices,
  },
  {
    id: 'running-total',
    kind: 'area',
    when: (s) =>
      s.dims[0]?.kind === 'time' &&
      s.dims.length <= 2 &&
      s.measures.length > 0 &&
      s.measures.every((m) => m.output === 'level' && m.modifierClass === 3),
  },
  { id: 'time-series', kind: 'line', when: (s) => s.dims.length === 1 && s.dims[0]?.kind === 'time' },
  {
    id: 'time-by-few',
    kind: 'line',
    when: (s) =>
      s.dims.length === 2 &&
      s.dims[0]?.kind === 'time' &&
      s.measures.length === 1 &&
      (s.dims[1]?.cardinality ?? Infinity) <= THRESHOLDS.maxLineSeries,
  },
  { id: 'number-axis', kind: 'line', when: (s) => s.dims.length === 1 && s.dims[0]?.kind === 'number' },
  { id: 'geo', kind: 'map', when: (s) => s.dims.length === 1 && s.dims[0]?.kind === 'geo' && s.measures.length === 1 },
  { id: 'entity-pair', kind: 'scatter', when: (s) => s.dims.length === 1 && s.dims[0]?.kind === 'entity' && s.measures.length === 2 },
  {
    id: 'dense-matrix',
    kind: 'heatmap',
    when: (s) =>
      s.dims.length === 2 && s.measures.length === 1 && s.dims.every((d) => d.cardinality > THRESHOLDS.heatmapAbove),
  },
  { id: 'two-cuts-many-measures', kind: 'table', when: (s) => s.dims.length === 2 && s.measures.length > 1 },
  { id: 'fallback', kind: 'bar', when: () => true },
];

export function chooseKind(shape: Shape): Rule {
  // `fallback` matches everything, so `find` always succeeds.
  return KIND_RULES.find((rule) => rule.when(shape))!;
}
