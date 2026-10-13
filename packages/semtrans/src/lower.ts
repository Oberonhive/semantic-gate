/**
 * CubeModel → the `c_*` facts of `rules/catalog.dl`, as Datalog source text.
 * Every default the model documents is applied here, so the rules see a cube
 * that says everything.
 */
import type { Json, ParamSchema } from '@semantic-gate/contract';
import type { CubeModel, Join } from './model.ts';
import { impliedAdditivity } from './parse.ts';

const q = (v: unknown): string => JSON.stringify(String(v));

export function lower(model: CubeModel): string {
  const out: string[] = [];
  const cube = q(model.cube);
  const fact = (rel: string, ...args: (string | number)[]): void => {
    out.push(`${rel}(${cube}, ${args.map((a) => (typeof a === 'number' ? a : q(a))).join(', ')}).`);
  };

  fact('c_cube', model.table, model.alias ?? 'o');
  for (const w of model.where ?? []) fact('c_where', w);
  for (const [k, v] of Object.entries(model.params ?? {})) fact('c_cparam', k, text(v));

  // a join's rank puts the joins it requires before it
  const rank = new Map<string, number>();
  const visit = (name: string, trail: string[]): void => {
    if (rank.has(name)) return;
    if (trail.includes(name)) throw new Error(`cube ${model.cube}: joins ${[...trail, name].join(' -> ')} require each other`);
    for (const r of model.joins?.[name]?.requires ?? []) visit(r, [...trail, name]);
    rank.set(name, rank.size);
  };
  for (const name of Object.keys(model.joins ?? {})) visit(name, []);
  for (const [name, j] of Object.entries(model.joins ?? {})) {
    const on = Array.isArray(j.on) ? j.on.map((c) => `(${c})`).join(' AND ') : j.on;
    fact('c_join', name, rank.get(name)!, (j as Join).kind === 'inner' ? 'INNER' : 'LEFT', j.table, j.alias, on);
    for (const r of j.requires ?? []) fact('c_join_req', name, r);
  }

  for (const [name, m] of Object.entries(model.metrics)) {
    fact('c_metric', name);
    fact('c_m_info', name, 'description', m.description ?? '');
    fact('c_m_info', name, 'value_type', m.value_type ?? 'number');
    fact('c_m_info', name, 'additivity', m.additivity ?? impliedAdditivity(m as never)!);
    if ('agg' in m) {
      fact('c_m_agg', name, m.agg, m.expr ?? '');
      if (m.filter !== undefined) fact('c_m_filter', name, m.filter);
    } else if ('sql' in m) fact('c_m_sql', name, m.sql);
    else if ('derived' in m) fact('c_m_derived', name, m.derived);
    else fact('c_m_two', name, m.two_stage.entity, m.two_stage.inner, m.two_stage.outer);
    for (const j of m.joins ?? []) fact('c_m_join', name, j);
    paramFacts(`m:${name}`, m.params);
    if (m.display) fact('c_display', `m:${name}`, JSON.stringify(m.display));
  }

  for (const [name, d] of Object.entries(model.dimensions)) {
    fact('c_dimension', name);
    const kind = d.kind ?? (d.grains ? 'time' : 'category');
    fact('c_d_info', name, 'description', d.description ?? '');
    fact('c_d_info', name, 'kind', kind);
    fact('c_d_info', name, 'value_type', d.value_type ?? (kind === 'time' ? 'date' : 'string'));
    fact('c_d_sql', name, d.sql);
    for (const g of d.grains ?? []) fact('c_d_grain', name, g);
    for (const j of d.joins ?? []) fact('c_d_join', name, j);
    paramFacts(`d:${name}`, d.params);
    if (d.display) fact('c_display', `d:${name}`, JSON.stringify(d.display));
  }

  for (const [name, m] of Object.entries(model.modifiers ?? {})) {
    fact('c_modifier', name, m.class, m.output, m.description);
    for (const a of m.requires ?? []) fact('c_mod_req', name, a);
    paramFacts(`x:${name}`, m.params);
    for (const p of m.required ?? []) fact('c_pa', `x:${name}`, p, 'required', '1');
  }
  return out.join('\n') + '\n';

  function paramFacts(owner: string, params: Record<string, ParamSchema> | undefined): void {
    for (const [p, s] of Object.entries(params ?? {})) {
      fact('c_pa', owner, p, 'type', s.type);
      for (const k of ['default', 'minimum', 'maximum', 'description'] as const) if (s[k] !== undefined) fact('c_pa', owner, p, k, text(s[k]));
      if (s.items) fact('c_pa', owner, p, 'items', s.items.type);
      (s.enum ?? []).forEach((v, i) => fact('c_pa_enum', owner, p, i, text(v)));
    }
  }
}

function text(v: Json | undefined): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}
