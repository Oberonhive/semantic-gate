/**
 * Stage 3 — how the chosen chart maps fields to channels. Each decision is
 * taken from a pinned hint when one exists, otherwise by the first applicable
 * line below, and recorded in `reasons`:
 *
 * | decision | rule |
 * |---|---|
 * | x | first dimension (time before category) |
 * | series | second dimension |
 * | value axes | one per distinct unit, at most `maxValueAxes`; a bar chart draws its second axis as lines |
 * | orientation | horizontal bars above `horizontalAbove` members or past `longLabel` |
 * | stack | `percent` for `share` outputs split by series; `stacked` for bar/area split by series when every measure is `stackable`; else `none` — a non-additive metric is never stacked, even when a hint asks |
 * | line style | class-2 `level` (prev_value) dashed; class-4 `level` (rolling) smooth |
 * | colour | metric `color`; `difference`/`ratio` alone: by sign and `good_when`; otherwise by member |
 * | marks | a zero line on any axis carrying a `signed` measure |
 * | sort | time ascending; categories by `display.order`, else the first measure descending; rest last; the query's `order` wins |
 * | legend | series split, or more than one measure |
 * | zoom | time axis above `zoomAbove` points |
 */
import type { ChartKind, VizHints } from '@semantic-gate/contract';
import { formatOf } from './format.ts';
import type { DimensionField, MeasureField, Shape } from './fields.ts';
import { THRESHOLDS } from './rules.ts';
import type { AxisSpec, ChartSpec, ColorSpec, MeasureEncoding, Reason } from './spec.ts';

const SERIES_KINDS: ChartKind[] = ['line', 'area', 'bar', 'heatmap'];

export function encode(kind: ChartKind, shape: Shape, hints: VizHints, kindRule: string): ChartSpec {
  const reasons: Reason[] = [{ decision: `kind=${kind}`, rule: hints.chart ? 'hint' : kindRule }];
  const why = (decision: string, rule: string) => reasons.push({ decision, rule });
  const dimNamed = (n?: string) => shape.dims.find((d) => d.name === n);

  // kpi and table have no channels: every column is shown as it is
  if (kind === 'kpi' || kind === 'table') return plain(kind, shape, hints, reasons);

  // x and series
  let x: DimensionField | undefined = dimNamed(hints.x);
  if (x) why(`x=${x.name}`, 'hint');
  else if ((x = shape.dims[0])) why(`x=${x.name}`, x.kind === 'time' ? 'time-first' : 'first-dimension');
  let series = SERIES_KINDS.includes(kind) ? dimNamed(hints.series) : undefined;
  if (series && series !== x) why(`series=${series.name}`, 'hint');
  else {
    series = SERIES_KINDS.includes(kind) ? shape.dims.find((d) => d !== x) : undefined;
    if (series) why(`series=${series.name}`, 'second-dimension');
  }
  if (series === x) series = undefined;

  // measures: a split or a pie carries one; extras would have no channel
  const split = series && kind !== 'heatmap';
  let measures = shape.measures;
  if ((split || kind === 'pie' || kind === 'map' || kind === 'heatmap') && measures.length > 1) {
    measures = measures.slice(0, 1);
    why(`y=${measures[0]!.name}`, 'one-measure-per-split');
  }

  // value axes: one per distinct unit
  const unitOf = (m: MeasureField) => unitKey(m);
  const units = [...new Set(measures.map(unitOf))];
  const axisOf = (m: MeasureField) => Math.min(units.indexOf(unitOf(m)), THRESHOLDS.maxValueAxes - 1);
  const axisCount = Math.min(units.length, THRESHOLDS.maxValueAxes);
  if (axisCount > 1 && (kind === 'bar' || kind === 'line' || kind === 'area')) why(`axes=${axisCount}`, 'distinct-units');
  const axes: AxisSpec[] = Array.from({ length: axisCount }, (_, i) => {
    const m = measures.find((mm) => axisOf(mm) === i)!;
    return { type: 'value', ...(unitOf(m) && { name: unitOf(m) }), format: formatOf(m, true) };
  });

  // orientation
  let orientation: ChartSpec['orientation'] = 'vertical';
  if (kind === 'bar' && x && x.kind !== 'time' && x.kind !== 'number') {
    const wide = x.cardinality > THRESHOLDS.horizontalAbove || x.maxLabelLength > THRESHOLDS.longLabel;
    orientation = hints.orientation ?? (wide ? 'horizontal' : 'vertical');
    if (hints.orientation) why(`orientation=${orientation}`, 'hint');
    else if (wide) why('orientation=horizontal', x.cardinality > THRESHOLDS.horizontalAbove ? 'many-members' : 'long-labels');
  }

  // stack
  let stack: ChartSpec['stack'] = 'none';
  if (split && (kind === 'bar' || kind === 'area')) {
    const stackable = measures.every((m) => m.stackable);
    const wanted = hints.stack ?? (measures.every((m) => m.output === 'share') ? 'percent' : stackable ? 'stacked' : 'none');
    if (wanted !== 'none' && !stackable && !measures.every((m) => m.output === 'share')) {
      why('stack=none', 'non-additive');
    } else {
      stack = wanted;
      if (stack !== 'none') why(`stack=${stack}`, hints.stack ? 'hint' : 'additive-split');
    }
  } else if (hints.stack && hints.stack !== 'none') why('stack=none', 'no-series-split');

  if (stack === 'percent') axes.splice(0, axes.length, { type: 'value', name: '%', format: { kind: 'percent', digits: 0 } });

  // measure encodings
  const only = measures.length === 1 ? measures[0]! : undefined;
  const y: MeasureEncoding[] = measures.map((m) => {
    let color: ColorSpec | undefined;
    if (m.color) color = { by: 'fixed', color: m.color };
    else if (kind === 'bar' && only && (m.output === 'difference' || m.output === 'ratio')) {
      color = { by: 'sign', goodWhen: m.goodWhen ?? 'up' };
      why(`color(${m.name})=sign`, 'signed-output');
    }
    const axis = axisOf(m);
    return {
      field: m.name,
      label: m.label,
      output: m.output,
      axis,
      format: formatOf(m),
      ...(m.output === 'level' && m.modifierClass === 2 && { line: 'dashed' as const }),
      ...(m.output === 'level' && m.modifierClass === 4 && { line: 'smooth' as const }),
      ...(kind === 'bar' && axisCount > 1 && axis > 0 && { asLine: true }),
      ...(color && { color }),
      ...(m.goodWhen && { goodWhen: m.goodWhen }),
    };
  });
  if (kind === 'bar' && axisCount > 1) why('second-axis=line', 'dual-axis-combo');

  // sort: a category x is ordered by the first measure, descending, unless the query orders
  let sort: ChartSpec['sort'];
  if (x && (kind === 'bar' || kind === 'pie' || kind === 'line' || kind === 'area') && x.kind !== 'time' && x.kind !== 'number' && measures[0]) {
    if (shape.ordered.length) why('sort=query', 'query-order');
    else if (x.order.length) why('sort=display.order', 'declared-order');
    else {
      sort = { field: measures[0].name, dir: 'desc' };
      why(`sort=${measures[0].name} desc`, 'largest-first');
    }
  }
  if (x?.hasRest || series?.hasRest) why('rest=last', 'mod-005');

  const signedAxes = [...new Set(measures.filter((m) => m.signed || m.output === 'difference' || m.output === 'ratio').map(axisOf))];
  const marks: ChartSpec['marks'] = signedAxes.map((axis) => ({ kind: 'zero', axis }));
  if (marks.length) why('marks=zero', 'signed-values');

  const timeX = x?.kind === 'time' && (kind === 'line' || kind === 'area' || kind === 'bar');
  const zoom = !!timeX && x!.cardinality > THRESHOLDS.zoomAbove;
  if (zoom) why('zoom', 'long-time-axis');
  const legend = kind === 'pie' || !!split || (measures.length > 1 && kind !== 'scatter');

  const xAxis: AxisSpec | undefined = x
    ? {
        type: x.kind === 'time' ? 'time' : x.kind === 'number' ? 'value' : 'category',
        field: x.name,
        name: x.label,
        ...(x.kind === 'time' && x.grain && { format: { kind: 'date' as const, grain: x.grain } }),
      }
    : undefined;

  return {
    kind,
    ...(x && { x: x.name }),
    ...(series && { series: series.name }),
    y,
    axes: { ...(xAxis && { x: xAxis }), y: axes },
    orientation,
    stack,
    ...(sort && { sort }),
    legend,
    zoom,
    marks,
    ...(hints.title && { title: hints.title }),
    reasons,
  };
}

function plain(kind: 'kpi' | 'table', shape: Shape, hints: VizHints, reasons: Reason[]): ChartSpec {
  const y: MeasureEncoding[] = shape.measures.map((m) => ({
    field: m.name,
    label: m.label,
    output: m.output,
    axis: 0,
    format: formatOf(m),
    ...(m.goodWhen && { goodWhen: m.goodWhen }),
  }));
  const columns = [
    ...shape.dims.map((d) => ({ column: d.column, field: d.name, label: d.label, ...(d.kind === 'time' && d.grain && { format: { kind: 'date' as const, grain: d.grain } }) })),
    ...shape.measures.map((m, i) => ({ column: m.column, field: m.name, label: m.label, format: y[i]!.format })),
  ]
    .sort((a, b) => a.column - b.column)
    .map(({ column: _column, ...c }) => c);
  return {
    kind,
    y,
    axes: { y: [] },
    orientation: 'vertical',
    stack: 'none',
    legend: false,
    zoom: false,
    marks: [],
    ...(hints.title && { title: hints.title }),
    ...(kind === 'table' && { columns }),
    reasons,
  };
}

/** The label of the unit a measure's values are in; measures sharing it share an axis. */
export function unitKey(m: MeasureField): string {
  if (m.output === 'ratio' || m.output === 'share' || m.format === 'percent') return '%';
  if (m.output === 'rank') return 'rank';
  return m.unit ?? '';
}
