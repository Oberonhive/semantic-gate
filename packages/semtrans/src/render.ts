/**
 * The plan relations → SQL text and columns, or a thrown Refusal. The rules
 * decide every clause; this prints them in order and quotes the aliases.
 */
import { Refusal } from '@semantic-gate/contract';
import type { Column, ErrorCode, Json, Plan, TimeGrain, ValueType } from '@semantic-gate/contract';
import type { Tuple } from '@semantic-gate/datalog';

type Rel = readonly Tuple[];
export type PlanRelations = Record<string, Rel>;

/** Which refusal to report when several hold: the first request error a caller can fix first. */
const SEVERITY: ErrorCode[] = [
  'unknown_metric', 'unknown_dimension', 'unknown_modifier', 'invalid_composition',
  'invalid_params', 'non_additive_violation', 'filter_op_not_allowed',
];

const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const rows = (r: PlanRelations, name: string): Rel => r[name] ?? [];
const forNode = (r: PlanRelations, name: string, node: string): Rel => rows(r, name).filter((t) => t[0] === node);
const byOrd = (rs: Rel): Tuple[] => [...rs].sort((a, b) => (a[1] as number) - (b[1] as number));

/** Throws the first refusal; returns nothing when the rules refused nothing. */
export function refusal(r: PlanRelations): void {
  const all = rows(r, 'refusal');
  if (all.length === 0) return;
  const first = [...all].sort((a, b) => SEVERITY.indexOf(a[0] as ErrorCode) - SEVERITY.indexOf(b[0] as ErrorCode))[0]!;
  throw new Refusal(first[0] as ErrorCode, String(first[1]), first[2] === '' ? undefined : String(first[2]));
}

export function render(r: PlanRelations): Plan {
  refusal(r);
  const nodes = [...rows(r, 'node')].sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0]! < b[0]! ? -1 : 1));
  if (nodes.length === 0) throw new Refusal('internal', 'the rules produced no plan');
  const text = (name: string): string => {
    const get = (rel: string): Tuple[] => byOrd(forNode(r, rel, name));
    const select = get('ncol').map((t) => `${t[3]} AS ${ident(String(t[2]))}`);
    const joins = get('njoin').map((j) => {
      const on = forNode(r, 'njoin_on', name).filter((t) => t[1] === j[1]).sort((a, b) => (a[2] as number) - (b[2] as number)).map((t) => `(${t[3]})`);
      return on.length ? `${j[2]} ON ${on.join(' AND ')}` : String(j[2]);
    });
    const part = (kw: string, rel: string, sep: string): string[] => {
      const items = get(rel).map((t) => String(t[2]));
      return items.length ? [`${kw} ${items.join(sep)}`] : [];
    };
    const limit = forNode(r, 'nlimit', name)[0];
    const suffix = forNode(r, 'nsuffix', name).map((t) => String(t[1]));
    return [
      `SELECT ${select.join(', ')}`,
      `FROM ${forNode(r, 'nfrom', name)[0]![1]}`,
      ...joins,
      ...part('WHERE', 'nwhere', ' AND '),
      ...part('GROUP BY', 'ngroup', ', '),
      ...part('HAVING', 'nhaving', ' AND '),
      ...part('ORDER BY', 'norder', ', '),
      ...(limit ? [`LIMIT ${limit[1]}`] : []),
      ...suffix,
    ].join('\n');
  };
  const last = nodes[nodes.length - 1]![0] as string;
  const ctes = nodes.slice(0, -1).map((n) => `${n[0]} AS (\n${text(n[0] as string).replace(/^/gm, '  ')}\n)`);
  const sql = (ctes.length ? `WITH ${ctes.join(',\n')}\n` : '') + text(last);
  const columns: Column[] = [...rows(r, 'ocol')]
    .sort((a, b) => (a[0] as number) - (b[0] as number))
    .map((t) => ({
      name: String(t[1]),
      role: t[2] as Column['role'],
      member: String(t[3]),
      ...(t[4] === '' ? {} : { modifier: String(t[4]) }),
      value_type: t[5] as ValueType,
      ...(t[6] === '' ? {} : { grain: t[6] as TimeGrain }),
    }));
  return { sql, columns, plan: { nodes: nodes.map((n) => n[0] as string) } as Json };
}
