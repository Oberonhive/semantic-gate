/**
 * PlanParams → the input facts of `rules/contract.dl`. The one lexical thing
 * the host does for the rules is render a JSON scalar as a SQL literal in the
 * target dialect (`lit`); the rules otherwise see values as text plus a type
 * tag, and decide everything else.
 */
import type { Dialect, Filter, Json, PlanParams } from '@semantic-gate/contract';
import type { Tuple } from '@semantic-gate/datalog';

type Facts = Record<string, Tuple[]>;

/** `type` tag, raw text, SQL literal. Objects get the tag `obj`: the rules refuse them. */
function scalar(v: Json, dialect: Dialect): [string, string, string] {
  if (typeof v === 'string') {
    const body = dialect === 'clickhouse' ? v.replaceAll('\\', '\\\\').replaceAll("'", "\\'") : v.replaceAll("'", "''");
    return ['str', v, `'${body}'`];
  }
  if (typeof v === 'number') return ['num', String(v), String(v)];
  if (typeof v === 'boolean') return ['bool', String(v), v ? 'TRUE' : 'FALSE'];
  if (v === null) return ['null', 'null', 'NULL'];
  return ['obj', '', 'NULL'];
}

/** Rows `[…, idx, text, lit, type, arr]` for a value: one row per array element, or one for a scalar. */
function values(v: Json | undefined, dialect: Dialect): [number, string, string, string, number][] {
  if (v === undefined) return [];
  const arr = Array.isArray(v);
  return (arr ? v : [v]).map((x, i) => {
    const [type, text, lit] = scalar(x, dialect);
    return [i, text, lit, type, arr ? 1 : 0];
  });
}

export function encode({ query: q, dialect, context }: PlanParams): Facts {
  const f: Facts = {
    q_dialect: [[dialect]],
    q_context: [[context.evaluation_time, context.timezone]],
    q_metric: q.metrics.map((m, i) => [i, m]),
    q_dim: (q.dimensions ?? []).map((d, i) => [i, d]),
    q_fnode: [],
    q_fpred: [],
    q_fval: [],
    q_mod: (q.modifiers ?? []).map((m, i) => [i, m.name]),
    q_modp: [],
    q_param: [],
    q_order: (q.order ?? []).map((o, i) => [i, o.field, o.dir]),
    q_limit: q.limit === undefined ? [] : [[q.limit]],
  };
  let ids = 0;
  const node = (flt: Filter, parent: number, idx: number): void => {
    const id = ids++;
    if ('items' in flt) {
      f.q_fnode!.push([id, flt.op, parent, idx]);
      flt.items.forEach((c, i) => node(c, id, i));
    } else {
      f.q_fnode!.push([id, 'pred', parent, idx]);
      f.q_fpred!.push([id, flt.field, flt.op]);
      for (const r of values(flt.value, dialect)) f.q_fval!.push([id, ...r]);
    }
  };
  if (q.filters) node(q.filters, -1, 0);
  (q.modifiers ?? []).forEach((m, i) => {
    for (const [k, v] of Object.entries(m.params ?? {})) for (const r of values(v, dialect)) f.q_modp!.push([i, k, ...r]);
  });
  for (const [k, v] of Object.entries(q.params ?? {})) for (const r of values(v, dialect)) f.q_param!.push([k, ...r]);
  return f;
}
