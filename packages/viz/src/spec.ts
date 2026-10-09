/**
 * The chart IR between inference and ECharts.
 *
 * Two callers cannot work on a finished option: hints, which pin a decision
 * (`x`, `series`, `stack`) before the dependent ones are made, and `reasons`,
 * which tell an agent or a human why the chart looks as it does. All JSON.
 */
import type { ChartKind, ModifierOutput } from '@semantic-gate/contract';
import type { FormatSpec } from './format.ts';

export type { ChartKind };

export interface ChartSpec {
  kind: ChartKind;
  /** The dimension on the category/time axis. */
  x?: string;
  /** The dimension whose members split series (the second axis of a heatmap). */
  series?: string;
  /** Measures drawn, each bound to a value axis. */
  y: MeasureEncoding[];
  /** `axes.y.length === 2` is a dual axis: one per unit. */
  axes: { x?: AxisSpec; y: AxisSpec[] };
  orientation: 'vertical' | 'horizontal';
  stack: 'none' | 'stacked' | 'percent';
  /** Presentation order of category members when the query has no `order`; `__rest__` is always last. */
  sort?: { field: string; dir: 'asc' | 'desc' };
  legend: boolean;
  /** `dataZoom` on a long time axis. */
  zoom: boolean;
  marks: ReferenceMark[];
  title?: string;
  /** `table` only: the columns an HTML table should show, in order. */
  columns?: TableColumn[];
  reasons: Reason[];
}

export interface MeasureEncoding {
  field: string;
  label: string;
  output: ModifierOutput | 'value';
  /** Index into `axes.y`. */
  axis: number;
  format: FormatSpec;
  /** `dashed` marks a comparison series (class-2 `level`, e.g. `prev_value`). */
  line?: 'solid' | 'dashed' | 'smooth';
  /** Drawn as a line over bars (the second axis of a bar chart). */
  asLine?: boolean;
  color?: ColorSpec;
  goodWhen?: 'up' | 'down';
}

export interface AxisSpec {
  type: 'time' | 'category' | 'value';
  field?: string;
  name?: string;
  format?: FormatSpec;
}

/** A zero line on a value axis carrying signed outputs. */
export interface ReferenceMark {
  kind: 'zero';
  axis: number;
}

export type ColorSpec =
  | { by: 'member' }
  | { by: 'sign'; goodWhen: 'up' | 'down' }
  | { by: 'fixed'; color: string };

export interface TableColumn {
  field: string;
  label: string;
  format?: FormatSpec;
}

/** One decision and the rule that made it, e.g. `{ decision: 'kind=line', rule: 'time-series' }`. */
export interface Reason {
  decision: string;
  rule: string;
}
