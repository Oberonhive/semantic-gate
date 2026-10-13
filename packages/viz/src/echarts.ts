/**
 * Stage 4 — `ChartSpec` + rows → a complete ECharts option.
 *
 * The option is JSON: rows go into `dataset.source` in presentation order
 * (time ascending; a category axis in its member order; the `__rest__` bucket
 * relabelled `Other`), series bind columns with `encode`, a series split is a
 * dataset `filter` transform per member, and formatters are `FormatRef`s for
 * `hydrate`.
 *
 * Kinds that ECharts does not draw from a dataset alone:
 * - `kpi` is `graphic` text elements: label, value, and a delta when a class-2
 *   output (a `difference` or `ratio` column) of the same metric was queried;
 * - `table` is `dataset` plus an empty `series` list — a host renders
 *   `spec.columns` and `dataset.source` as an HTML table instead of a canvas;
 * - `map` draws on the registered map `world` (`WORLD_MAP`): the host must
 *   `registerMap('world', geoJson)` with the ECharts 4.9 `world.json`.
 */
import type { Json, Response } from '@semantic-gate/contract';
import { REST_MEMBER, type DimensionField, type Shape } from './fields.ts';
import { ref, type FormatSpec } from './format.ts';
import { WORLD_MAP, worldRegion } from './geo.ts';
import type { ChartSpec, MeasureEncoding } from './spec.ts';

export interface Theme {
  /** Series colours, assigned per member by a stable hash. */
  palette?: string[];
  /** The `__rest__` bucket. */
  neutral?: string;
  good?: string;
  bad?: string;
  /** KPI value and label text. */
  text?: string;
  muted?: string;
}

const DEFAULT_THEME: Required<Theme> = {
  palette: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'],
  neutral: '#a0a4ab',
  good: '#2e9e6b',
  bad: '#d6504a',
  text: '#2b2f36',
  muted: '#80858d',
};

/** Grid lines readable on a light and on a dark background alike. */
const GRID = 'rgba(128, 128, 128, 0.25)';

/** What the `__rest__` bucket is called on screen. */
export const REST_LABEL = 'Other';

type Opt = Record<string, unknown>;

/** FNV-1a with murmur finalizer (biviz2 `colorOf`): one member, one starting colour, in every chart. */
function hashSlot(key: string, size: number): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % size;
}

const label = (m: Json) => (m === REST_MEMBER ? REST_LABEL : m === null ? '—' : String(m));
const cell = (v: Json) => (v === REST_MEMBER ? REST_LABEL : v);

export function toEcharts(spec: ChartSpec, shape: Shape, response: Response, theme: Theme = {}): Opt {
  const t = { ...DEFAULT_THEME, ...theme };
  const dim = (name?: string) => shape.dims.find((d) => d.name === name);
  const x = dim(spec.x);
  const seriesDim = dim(spec.series);
  const names = response.columns.map((c) => c.name);
  const relabel = new Set([x, seriesDim].filter((d) => d?.hasRest).map((d) => d!.column));
  let rows = response.rows.map((r) => r.map((v, i) => (relabel.has(i) ? cell(v) : v)));

  /** Declared colour, neutral for the rest bucket, else the hashed palette slot; a slot taken by an earlier member of the chart is skipped. */
  const taken = new Map<string, Set<number>>();
  const chosen = new Map<string, string>();
  const memberColor = (d: DimensionField, m: Json) => {
    const key = `${d.name}\n${String(m)}`;
    const declared = d.colors[String(m)];
    if (declared) return declared;
    if (m === REST_MEMBER || m === REST_LABEL) return t.neutral;
    if (chosen.has(key)) return chosen.get(key)!;
    const used = taken.get(d.name) ?? taken.set(d.name, new Set()).get(d.name)!;
    let slot = hashSlot(key, t.palette.length);
    for (let i = 0; i < t.palette.length && used.has(slot); i++) slot = (slot + 1) % t.palette.length;
    used.add(slot);
    chosen.set(key, t.palette[slot]!);
    return t.palette[slot]!;
  };

  /** Members in presentation order: query order → declared order → largest first; the rest bucket last. */
  const membersOf = (d: DimensionField): Json[] => {
    const ms = d.members.map(cell);
    const totals = new Map<Json, number>();
    const first = shape.measures.find((m) => m.name === spec.sort?.field);
    if (first) for (const r of rows) totals.set(r[d.column]!, (totals.get(r[d.column]!) ?? 0) + (Number(r[first.column]) || 0));
    const rank = (m: Json) => {
      const i = d.order.indexOf(String(m));
      return i < 0 ? d.order.length : i;
    };
    const sorted = [...ms].sort((a, b) => {
      if (shape.ordered.length) return 0;
      if (d.order.length) return rank(a) - rank(b);
      if (spec.sort && d === x) return (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
      return 0;
    });
    return [...sorted.filter((m) => m !== REST_LABEL), ...sorted.filter((m) => m === REST_LABEL)];
  };

  const title = spec.title ? { title: { text: spec.title, top: 0, left: 0, textStyle: { fontSize: 15, color: t.text } } } : {};
  const dataset = (extra: Opt[] = [], dims = names, source: Json[][] = rows): Opt[] => [{ dimensions: dims, source }, ...extra];
  const nameOf = (m: MeasureEncoding) => m.label;

  if (spec.kind === 'table') {
    return { ...title, dataset: dataset(), series: [] };
  }
  if (spec.kind === 'kpi') return kpi(spec, shape, rows, t, title);

  if (spec.kind === 'pie' && x) {
    const order = membersOf(x);
    rows = order.flatMap((m) => rows.filter((r) => r[x.column] === m));
    const m = spec.y[0]!;
    return {
      ...title,
      dataset: dataset(),
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: t.text } },
      tooltip: { trigger: 'item', valueFormatter: ref(m.format) },
      series: [
        {
          type: 'pie',
          radius: ['40%', '68%'],
          center: ['38%', '54%'],
          color: order.map((mem) => memberColor(x, mem)),
          encode: { itemName: x.name, value: m.field },
          label: { formatter: '{b}  {d}%', color: t.text },
        },
      ],
    };
  }

  if (spec.kind === 'map' && x) {
    const m = spec.y[0]!;
    const col = shape.measures.find((mm) => mm.name === m.field)!.column;
    const vals = rows.map((r) => Number(r[col]) || 0);
    return {
      ...title,
      tooltip: { trigger: 'item', valueFormatter: ref(m.format) },
      visualMap: {
        min: Math.min(0, ...vals),
        max: Math.max(1, ...vals),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        formatter: ref(m.format),
        inRange: { color: ['#e8eefb', t.palette[0]] },
      },
      series: [
        {
          type: 'map',
          map: WORLD_MAP,
          roam: true,
          name: m.label,
          data: rows.map((r) => ({ name: worldRegion(String(r[x.column])), value: r[col] })),
        },
      ],
    };
  }

  if (spec.kind === 'scatter' && x) {
    const [mx, my] = spec.y as [MeasureEncoding, MeasureEncoding];
    const axis = (m: MeasureEncoding) => ({ type: 'value', name: m.label, scale: true, axisLabel: { formatter: ref(m.format) } });
    return {
      ...title,
      dataset: dataset(),
      grid: grid(spec, false),
      tooltip: { trigger: 'item' },
      xAxis: axis(mx),
      yAxis: axis(my),
      series: [{ type: 'scatter', symbolSize: 8, encode: { x: mx.field, y: my.field, itemName: x.name, tooltip: [x.name, mx.field, my.field] } }],
    };
  }

  if (spec.kind === 'heatmap' && x && seriesDim) {
    const m = spec.y[0]!;
    const col = shape.measures.find((mm) => mm.name === m.field)!.column;
    const vals = rows.map((r) => Number(r[col]) || 0);
    return {
      ...title,
      dataset: dataset(),
      grid: { ...grid(spec, false), bottom: 56 },
      tooltip: { trigger: 'item', valueFormatter: ref(m.format) },
      xAxis: { type: 'category', data: membersOf(x), name: x.label },
      yAxis: { type: 'category', data: membersOf(seriesDim), name: seriesDim.label },
      visualMap: {
        min: Math.min(...vals),
        max: Math.max(...vals),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        formatter: ref(m.format),
        inRange: { color: ['#e8eefb', t.palette[0]] },
      },
      series: [{ type: 'heatmap', encode: { x: x.name, y: seriesDim.name, value: m.field } }],
    };
  }

  return cartesian(spec, shape, x, seriesDim, names, rows, t, title, membersOf, memberColor, nameOf);
}

function grid(spec: ChartSpec, legend: boolean): Opt {
  const top = (spec.title ? 30 : 6) + (legend ? 30 : 0) + 22;
  return { left: 8, right: 16, top, bottom: spec.zoom ? 52 : 8, containLabel: true };
}

function cartesian(
  spec: ChartSpec,
  shape: Shape,
  x: DimensionField | undefined,
  seriesDim: DimensionField | undefined,
  names: string[],
  rows: Json[][],
  t: Required<Theme>,
  title: Opt,
  membersOf: (d: DimensionField) => Json[],
  memberColor: (d: DimensionField, m: Json) => string,
  nameOf: (m: MeasureEncoding) => string,
): Opt {
  const horizontal = spec.orientation === 'horizontal';
  const timeX = x?.kind === 'time';
  const catX = !!x && x.kind !== 'time' && x.kind !== 'number';
  const xOrder = catX ? membersOf(x) : [];

  if (x && timeX && !shape.ordered.includes(x.name)) {
    rows = [...rows].sort((a, b) => (a[x.column]! < b[x.column]! ? -1 : a[x.column]! > b[x.column]! ? 1 : 0));
  } else if (x && catX && !seriesDim) {
    rows = xOrder.flatMap((m) => rows.filter((r) => r[x.column] === m));
  }

  // Percent stacks plot a derived share-of-column; the rows themselves stay as returned.
  const pct = spec.stack === 'percent';
  const pctName = (f: string) => `${f}__pct`;
  let dims = names;
  if (pct && x) {
    const sums = new Map<Json, number>();
    const cols = spec.y.map((m) => shape.measures.find((mm) => mm.name === m.field)!.column);
    for (const r of rows) sums.set(r[x.column]!, (sums.get(r[x.column]!) ?? 0) + (Number(r[cols[0]!]) || 0));
    rows = rows.map((r) => [...r, ...cols.map((c) => (Number(r[c]) || 0) / (sums.get(r[x.column]!) || 1))]);
    dims = [...names, ...spec.y.map((m) => pctName(m.field))];
  }

  const members = seriesDim ? membersOf(seriesDim) : [];
  const datasets: Opt[] = [{ dimensions: dims, source: rows }];
  members.forEach((m) =>
    datasets.push({ fromDatasetIndex: 0, transform: { type: 'filter', config: { dimension: seriesDim!.name, '=': m } } }),
  );

  const series: Opt[] = [];
  const zeroDone = new Set<number>();
  const push = (m: MeasureEncoding, datasetIndex: number, name: string, color: string | undefined) => {
    const value = pct ? pctName(m.field) : m.field;
    const asLine = spec.kind !== 'bar' || m.asLine;
    const s: Opt = {
      type: asLine ? 'line' : 'bar',
      name,
      datasetIndex,
      encode: horizontal ? { y: x!.name, x: value } : { x: x!.name, y: value },
      [horizontal ? 'xAxisIndex' : 'yAxisIndex']: m.axis,
      tooltip: { valueFormatter: ref(pct ? { kind: 'percent', digits: 1 } : m.format) },
    };
    if (asLine) s.showSymbol = rows.length <= 60;
    if (spec.kind === 'area') s.areaStyle = {};
    if (m.line === 'dashed') s.lineStyle = { type: 'dashed' };
    if (m.line === 'smooth') s.smooth = true;
    if (spec.stack !== 'none') s.stack = 'total';
    if (color) s.color = color;
    if (spec.marks.some((k) => k.axis === m.axis) && !zeroDone.has(m.axis)) {
      zeroDone.add(m.axis);
      s.markLine = {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: t.muted, width: 1, type: 'solid' },
        data: [horizontal ? { xAxis: 0 } : { yAxis: 0 }],
      };
    }
    series.push(s);
    return s;
  };

  if (seriesDim) {
    members.forEach((mem, k) => push(spec.y[0]!, k + 1, label(mem), memberColor(seriesDim, mem)));
  } else {
    const barCount = spec.y.filter((m) => spec.kind === 'bar' && !m.asLine).length;
    spec.y.forEach((m, i) => {
      // Explicit per measure: a per-bar colour array on one series would otherwise
      // leave the next series on the same palette slot.
      const own = m.color?.by === 'fixed' ? m.color.color : t.palette[i % t.palette.length]!;
      const s = push(m, 0, nameOf(m), own);
      // One bar series coloured per bar: sign, declared member colours, or the neutral rest bucket.
      if (s.type === 'bar' && barCount === 1 && x) {
        const col = shape.measures.find((mm) => mm.name === m.field)!.column;
        const base = own;
        const bySign = m.color?.by === 'sign' ? m.color : undefined;
        if (bySign || x.hasRest || Object.keys(x.colors).length) {
          s.colorBy = 'data';
          s.color = rows.map((r) => {
            if (bySign) return (Number(r[col]) >= 0) === (bySign.goodWhen === 'up') ? t.good : t.bad;
            return x.colors[String(r[x.column])] ?? (r[x.column] === REST_LABEL ? t.neutral : base);
          });
        }
      }
    });
  }

  const valueKey = horizontal ? 'xAxis' : 'yAxis';
  const catKey = horizontal ? 'yAxis' : 'xAxis';
  const valueAxes = spec.axes.y.map((a, i) => ({
    type: 'value',
    ...(pct && { max: 1 }),
    ...(a.name && { name: a.name }),
    axisLabel: { hideOverlap: true, formatter: ref(pct ? { kind: 'percent', digits: 0 } : a.format!) },
    splitLine: i > 0 ? { show: false } : { lineStyle: { color: GRID } },
    ...(i > 0 && !horizontal && { position: 'right' }),
    ...(i > 0 && horizontal && { position: 'top' }),
  }));
  const axisX: Opt = !x
    ? { type: 'category' }
    : timeX
      ? { type: 'time' }
      : catX
        ? { type: 'category', data: xOrder, ...(horizontal && { inverse: true }) }
        : { type: 'value', scale: true, name: x.label };

  return {
    ...title,
    dataset: datasets,
    legend: { show: spec.legend, type: 'scroll', top: spec.title ? 28 : 4, textStyle: { color: t.text } },
    tooltip: { trigger: 'axis' },
    grid: grid(spec, spec.legend),
    [catKey]: axisX,
    [valueKey]: valueAxes,
    series,
    ...(spec.zoom && { dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }] }),
  };
}

function kpi(spec: ChartSpec, shape: Shape, rows: Json[][], t: Required<Theme>, title: Opt): Opt {
  const row = rows[0];
  const measure = (m: MeasureEncoding) => shape.measures.find((mm) => mm.name === m.field)!;
  const isDelta = (m: MeasureEncoding) => m.output === 'difference' || m.output === 'ratio';
  const mains = spec.y.filter((m) => !isDelta(m));
  const heads = mains.length ? mains : spec.y;
  const text = (left: number, top: number, content: unknown, style: Opt): Opt => ({
    type: 'text',
    left: `${left}%`,
    top: `${top}%`,
    style: { text: content, ...style },
  });
  const graphic = heads.flatMap((m, i) => {
    const left = (i * 100) / heads.length + 3;
    const value = row ? (row[measure(m).column] ?? null) : null;
    const out: Opt[] = [
      text(left, 22, m.label, { fill: t.muted, fontSize: 13 }),
      text(left, 34, ref(m.format, value as number | null), { fill: t.text, fontSize: 36, fontWeight: 'bold' }),
    ];
    const d = isDelta(m) ? undefined : spec.y.find((o) => isDelta(o) && measure(o).member === measure(m).member);
    if (d && row) {
      const dv = row[measure(d).column];
      const good = typeof dv === 'number' ? (dv >= 0) === ((d.goodWhen ?? m.goodWhen ?? 'up') === 'up') : undefined;
      out.push(text(left, 62, ref(d.format, dv as number | null), { fill: good === undefined ? t.muted : good ? t.good : t.bad, fontSize: 15 }));
      out.push(text(left, 72, d.label, { fill: t.muted, fontSize: 11 }));
    }
    return out;
  });
  return { ...title, graphic };
}

const isObject = (v: unknown): v is Opt => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The caller's raw override has the last word: objects merge by key, arrays by index. */
export function mergeOverride<T>(option: T, override: Record<string, unknown> | undefined): T {
  if (!override) return option;
  const merge = (a: unknown, b: unknown): unknown => {
    if (isObject(a) && isObject(b)) {
      const out: Opt = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
      return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return b.map((v, i) => (i < a.length ? merge(a[i], v) : v)).concat(a.slice(b.length));
    }
    return b;
  };
  return merge(option, override) as T;
}

export type { FormatSpec };
