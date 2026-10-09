/**
 * What both importers share: turning a column expression written for one
 * table ("revenue - cost") into a CubeModel fragment that names its table by
 * alias ("o.revenue - o.cost"), and the grain ladder of a time dimension.
 */
import type { TimeGrain } from '@semantic-gate/contract';

export const GRAINS: readonly TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

/** Grains from `from` upward; throws for a granularity the contract has no grain for (hour, minute, …). */
export function grainsFrom(from: string, where: string): TimeGrain[] {
  const i = GRAINS.indexOf(from as TimeGrain);
  if (i < 0) throw new Error(`${where}: time granularity "${from}" is not supported (grains are ${GRAINS.join(', ')})`);
  return GRAINS.slice(i) as TimeGrain[];
}

// Words that are SQL syntax, not columns. `select`/`from` are refused rather than skipped:
// a subquery inside a metric expression cannot be qualified by alias.
const KEYWORDS = new Set([
  'and', 'or', 'not', 'is', 'null', 'in', 'like', 'ilike', 'between', 'case', 'when', 'then', 'else', 'end',
  'distinct', 'as', 'asc', 'desc', 'true', 'false', 'over', 'partition', 'by', 'order', 'interval',
  'current_date', 'current_timestamp', 'filter', 'where', 'rows', 'range', 'unbounded', 'preceding', 'following',
  'current', 'row', 'nulls', 'first', 'last',
]);
const DATE_PARTS = new Set(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'dow', 'doy', 'epoch']);

const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\{[^}]*\}|[A-Za-z_][A-Za-z_0-9$]*|\d+(?:\.\d+)?|\s+|::|[\s\S]/g;

/**
 * Prefix every bare column in `sql` with `alias.`. Function names, keywords,
 * literals, `{holes}`, already-qualified names and cast targets are left alone.
 */
export function qualify(sql: string, alias: string, where: string): string {
  const toks = sql.match(TOKEN) ?? [];
  let out = '';
  let prev = ''; // previous significant token
  let prev2 = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (/^\s+$/.test(t)) {
      out += t;
      continue;
    }
    let next = '';
    for (let j = i + 1; j < toks.length; j++) {
      if (!/^\s+$/.test(toks[j]!)) {
        next = toks[j]!;
        break;
      }
    }
    const word = /^[A-Za-z_]/.test(t);
    const quoted = t.startsWith('"');
    if (word || quoted) {
      const lower = t.toLowerCase();
      if (word && (lower === 'select' || lower === 'from') && !(lower === 'from' && DATE_PARTS.has(prev.toLowerCase())))
        throw new Error(`${where}: a subquery in an expression cannot be qualified by alias ("${sql}")`);
      const isColumn =
        prev !== '.' &&
        next !== '.' &&
        next !== '(' &&
        !(word && KEYWORDS.has(lower)) &&
        !(word && lower === 'from') &&
        !(word && DATE_PARTS.has(lower) && prev === '(' && prev2.toLowerCase() === 'extract') &&
        !(word && DATE_PARTS.has(lower) && next.toLowerCase() === 'from') &&
        !(word && prev.toLowerCase() === 'as') &&
        prev !== '::' &&
        !(word && next.startsWith("'")); // typed literal: date '2020-01-01'
      out += isColumn ? `${alias}.${t}` : t;
    } else out += t;
    prev2 = prev;
    prev = t;
  }
  return out;
}

/** A short unique SQL alias for a table: initials of its words (`customer_dim` → `cd`), then a counter. */
export function aliasFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toLowerCase()).join('') || 't';
  let a = base;
  for (let n = 2; taken.has(a); n++) a = base + n;
  return a;
}

/** Display hints carried in free-form `meta` (dbt `config.meta`, cube.dev `meta`); other keys are ignored. */
export function metricMeta(meta: unknown): { unit?: string; format?: string; decimals?: number; good_when?: 'up' | 'down'; color?: string; value_type?: string } {
  const m = (meta ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['unit', 'format', 'decimals', 'good_when', 'color', 'value_type']) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export function dimensionMeta(meta: unknown): { kind?: string; value_type?: string; default_grain?: string; order?: unknown[]; colors?: Record<string, string> } {
  const m = (meta ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['kind', 'value_type', 'default_grain', 'order', 'colors']) if (m[k] !== undefined) out[k] = m[k];
  return out;
}
