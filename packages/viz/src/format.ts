/**
 * Number and date formats as data.
 *
 * An ECharts option with formatter *functions* cannot leave the process that
 * built it. The emitter writes a `FormatRef` wherever ECharts expects a
 * formatter, and the rendering side calls `hydrate` before `setOption`. A ref
 * that carries a `value` is a static label and becomes a string.
 */
import type { TimeGrain } from '@semantic-gate/contract';
import type { MeasureField } from './fields.ts';

export type FormatSpec =
  | { kind: 'number'; digits: number; compactFrom?: number; unit?: string; signed?: boolean }
  | { kind: 'percent'; digits: number; signed?: boolean }
  | { kind: 'currency'; currency: string; digits: number; compactFrom?: number; signed?: boolean }
  | { kind: 'duration' }
  | { kind: 'date'; grain: TimeGrain };

/** A JSON-safe placeholder for a formatter function, or (with `value`) for its result. */
export interface FormatRef {
  $format: FormatSpec;
  value?: number | string | null;
}

export const ref = (spec: FormatSpec, value?: FormatRef['value']): FormatRef =>
  value === undefined ? { $format: spec } : { $format: spec, value };

/** `compact` is for axis labels; tooltips and labels show the full value. */
export function formatOf(m: MeasureField, compact = false): FormatSpec {
  const signed = m.output === 'difference' || m.output === 'ratio' ? true : undefined;
  const compactFrom = compact ? 1e4 : undefined;
  if (m.output === 'ratio' || m.output === 'share' || m.format === 'percent') {
    return { kind: 'percent', digits: m.decimals ?? 1, ...(signed && { signed }) };
  }
  if (m.output === 'rank') return { kind: 'number', digits: 0 };
  if (m.format === 'duration') return { kind: 'duration' };
  if (m.format === 'currency' && m.currency) {
    return {
      kind: 'currency',
      currency: m.currency,
      digits: m.decimals ?? 0,
      ...(compactFrom && { compactFrom }),
      ...(signed && { signed }),
    };
  }
  return {
    kind: 'number',
    digits: m.decimals ?? (m.integer ? 0 : 1),
    ...(compactFrom && { compactFrom }),
    ...(m.unit && { unit: m.unit }),
    ...(signed && { signed }),
  };
}

function toDate(v: unknown): Date | undefined {
  if (typeof v === 'number') return new Date(v);
  if (typeof v !== 'string') return undefined;
  // A bare date is a calendar day, not an instant: read and print it in UTC.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function duration(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  const parts = [[Math.floor(s / 86400), 'd'], [Math.floor((s % 86400) / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']] as const;
  const shown = parts.filter(([n]) => n > 0).slice(0, 2).map(([n, u]) => `${n}${u}`);
  return (seconds < 0 ? '-' : '') + (shown.join(' ') || '0s');
}

/** The function a `FormatSpec` stands for, in `locale`. `null` is a dash. */
export function formatter(spec: FormatSpec, locale: string): (v: unknown) => string {
  const sign = (s?: boolean) => (s ? ({ signDisplay: 'exceptZero' } as const) : {});
  if (spec.kind === 'date') {
    return (v) => {
      const d = toDate(v);
      if (!d) return v == null ? '—' : String(v);
      const utc = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'UTC' : undefined;
      const tz = utc ? { timeZone: utc } : {};
      if (spec.grain === 'year') return new Intl.DateTimeFormat(locale, { year: 'numeric', ...tz }).format(d);
      if (spec.grain === 'month') return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', ...tz }).format(d);
      if (spec.grain === 'quarter') {
        const q = Math.floor((utc ? d.getUTCMonth() : d.getMonth()) / 3) + 1;
        return `Q${q} ${utc ? d.getUTCFullYear() : d.getFullYear()}`;
      }
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...tz }).format(d);
    };
  }
  if (spec.kind === 'duration') return (v) => (v == null ? '—' : duration(Number(v)));
  const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, o);
  if (spec.kind === 'percent') {
    const f = nf({ style: 'percent', minimumFractionDigits: spec.digits, maximumFractionDigits: spec.digits, ...sign(spec.signed) });
    return (v) => (v == null ? '—' : f.format(Number(v)));
  }
  const fixed = nf({
    ...(spec.kind === 'currency' ? { style: 'currency', currency: spec.currency } : {}),
    minimumFractionDigits: 0,
    maximumFractionDigits: spec.digits,
    ...sign(spec.signed),
  });
  const compact = nf({
    ...(spec.kind === 'currency' ? { style: 'currency', currency: spec.currency } : {}),
    notation: 'compact',
    maximumFractionDigits: 1,
    ...sign(spec.signed),
  });
  const unit = spec.kind === 'number' && spec.unit ? ` ${spec.unit}` : '';
  return (v) => {
    if (v == null) return '—';
    const n = Number(v);
    return (spec.compactFrom !== undefined && Math.abs(n) >= spec.compactFrom ? compact : fixed).format(n) + unit;
  };
}

const isRef = (v: unknown): v is FormatRef => typeof v === 'object' && v !== null && '$format' in v;

/** Extract the value from what ECharts hands a formatter: a number, or `{ value }` (`[.., v]` for rows). */
const valueOf = (arg: unknown): unknown => {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return arg;
  const v = (arg as { value?: unknown }).value;
  return Array.isArray(v) ? v[v.length - 1] : v;
};

/** Replace every `FormatRef` in `option` with an `Intl`-backed function (or string) for `locale`. */
export function hydrate<T>(option: T, locale: string): T {
  const walk = (node: unknown): unknown => {
    if (isRef(node)) {
      const fn = formatter(node.$format, locale);
      return node.value !== undefined ? fn(node.value) : (arg: unknown) => fn(valueOf(arg));
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(option) as T;
}
