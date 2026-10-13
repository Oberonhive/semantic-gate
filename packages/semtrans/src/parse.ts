/**
 * A YAML cube file → CubeModel. Structure is checked here so a mistake is
 * reported against the file and the key path that holds it; meaning (does this
 * metric exist, is this SQL valid) is the rules' and the warehouse's business.
 */
import { parse } from 'yaml';
import type { ParamSchema } from '@semantic-gate/contract';
import type { CubeModel } from './model.ts';

type Obj = Record<string, unknown>;

const AGGS = ['sum', 'count', 'count_distinct', 'min', 'max', 'avg'];
const ADDITIVITY = ['additive', 'semi_additive', 'mergeable', 'non_reaggregable'];
const KINDS = ['time', 'category', 'number', 'geo', 'entity'];
const VALUE_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'];
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const OUTPUTS = ['level', 'difference', 'ratio', 'share', 'rank', 'rows'];
const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array'];

/** Additivity a metric has without saying so; undefined when the author must say. */
export function impliedAdditivity(m: Obj): string | undefined {
  if (m.agg === 'sum' || m.agg === 'count') return 'additive';
  if (m.agg === 'min' || m.agg === 'max') return 'mergeable';
  if ('derived' in m || 'two_stage' in m) return 'non_reaggregable';
  return undefined;
}

export function parseCube(text: string, file: string): CubeModel {
  const fail = (path: string, message: string): never => {
    throw new Error(`${file}: ${path || '(top level)'}: ${message}`);
  };
  const obj = (v: unknown, path: string): Obj =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : fail(path, 'expected a mapping');
  const keys = (o: Obj, path: string, allowed: string[], required: string[] = []): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`.replace(/^\./, ''), `unknown key (expected one of: ${allowed.join(', ')})`);
    for (const k of required) if (o[k] === undefined) fail(`${path}.${k}`.replace(/^\./, ''), 'required');
  };
  const str = (v: unknown, path: string): string => (typeof v === 'string' ? v : fail(path, 'expected a string'));
  const oneOf = (v: unknown, path: string, set: string[]): string =>
    typeof v === 'string' && set.includes(v) ? v : fail(path, `expected one of: ${set.join(', ')}`);
  const list = (v: unknown, path: string, one: (x: unknown, p: string) => string): string[] =>
    Array.isArray(v) ? v.map((x, i) => one(x, `${path}[${i}]`)) : fail(path, 'expected a list');
  const check = (cond: boolean, path: string, message: string): void => { if (!cond) fail(path, message); };

  const params = (v: unknown, path: string): Record<string, ParamSchema> => {
    const out: Record<string, ParamSchema> = {};
    for (const [name, p] of Object.entries(obj(v, path))) {
      const at = `${path}.${name}`;
      const o = obj(p, at);
      keys(o, at, ['type', 'enum', 'minimum', 'maximum', 'items', 'default', 'description'], ['type']);
      oneOf(o.type, `${at}.type`, PARAM_TYPES);
      if (o.items !== undefined) {
        keys(obj(o.items, `${at}.items`), `${at}.items`, ['type'], ['type']);
        oneOf((o.items as Obj).type, `${at}.items.type`, PARAM_TYPES.filter((t) => t !== 'array'));
      }
      check(o.enum === undefined || Array.isArray(o.enum), `${at}.enum`, 'expected a list');
      out[name] = o as unknown as ParamSchema;
    }
    return out;
  };
  const display = (v: unknown, path: string): void => { obj(v, path); };
  const joinRefs = (o: Obj, path: string, joins: Obj): void => {
    if (o.joins === undefined) return;
    list(o.joins, `${path}.joins`, (j, p) => { check(typeof j === 'string' && j in joins, p, `no join named ${JSON.stringify(j)} in this cube`); return j as string; });
  };

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const top = obj(doc, '');
  keys(top, '', ['cube', 'table', 'alias', 'description', 'where', 'params', 'joins', 'metrics', 'dimensions', 'modifiers'], ['cube', 'table', 'metrics', 'dimensions']);
  str(top.cube, 'cube'); str(top.table, 'table');
  if (top.alias !== undefined) str(top.alias, 'alias');
  if (top.description !== undefined) str(top.description, 'description');
  if (top.where !== undefined) list(top.where, 'where', str);
  if (top.params !== undefined) obj(top.params, 'params');

  const joins = top.joins === undefined ? {} : obj(top.joins, 'joins');
  for (const [name, j] of Object.entries(joins)) {
    const at = `joins.${name}`;
    const o = obj(j, at);
    keys(o, at, ['table', 'alias', 'on', 'kind', 'requires'], ['table', 'alias', 'on']);
    str(o.table, `${at}.table`); str(o.alias, `${at}.alias`);
    if (Array.isArray(o.on)) list(o.on, `${at}.on`, str); else str(o.on, `${at}.on`);
    if (o.kind !== undefined) oneOf(o.kind, `${at}.kind`, ['left', 'inner']);
    if (o.requires !== undefined) list(o.requires, `${at}.requires`, (r, p) => { check(typeof r === 'string' && r in joins && r !== name, p, `no other join named ${JSON.stringify(r)}`); return r as string; });
  }

  const metrics = obj(top.metrics, 'metrics');
  check(Object.keys(metrics).length > 0, 'metrics', 'a cube needs at least one metric');
  for (const [name, m] of Object.entries(metrics)) {
    const at = `metrics.${name}`;
    const o = obj(m, at);
    keys(o, at, ['description', 'value_type', 'additivity', 'joins', 'params', 'display', 'agg', 'expr', 'filter', 'sql', 'derived', 'two_stage']);
    const forms = ['agg', 'sql', 'derived', 'two_stage'].filter((k) => k in o);
    check(forms.length === 1, at, `exactly one of agg, sql, derived, two_stage (found ${forms.length === 0 ? 'none' : forms.join(', ')})`);
    if (o.description !== undefined) str(o.description, `${at}.description`);
    if (o.value_type !== undefined) oneOf(o.value_type, `${at}.value_type`, VALUE_TYPES);
    if (o.additivity !== undefined) oneOf(o.additivity, `${at}.additivity`, ADDITIVITY);
    if (o.agg !== undefined) oneOf(o.agg, `${at}.agg`, AGGS);
    if (o.agg !== 'count') check(o.agg === undefined || o.expr !== undefined, `${at}.expr`, `required for agg ${o.agg}`);
    check(o.agg !== undefined || (o.expr === undefined && o.filter === undefined), at, 'expr and filter belong to agg metrics');
    for (const k of ['expr', 'filter', 'sql', 'derived'] as const) if (o[k] !== undefined) str(o[k], `${at}.${k}`);
    if (o.two_stage !== undefined) {
      const t = obj(o.two_stage, `${at}.two_stage`);
      keys(t, `${at}.two_stage`, ['entity', 'inner', 'outer'], ['entity', 'inner', 'outer']);
      for (const k of ['entity', 'inner', 'outer']) str(t[k], `${at}.two_stage.${k}`);
    }
    check(o.additivity !== undefined || impliedAdditivity(o) !== undefined, `${at}.additivity`, 'required for this kind of metric');
    joinRefs(o, at, joins);
    if (o.params !== undefined) params(o.params, `${at}.params`);
    if (o.display !== undefined) display(o.display, `${at}.display`);
  }

  const dimensions = obj(top.dimensions, 'dimensions');
  check(Object.keys(dimensions).length > 0, 'dimensions', 'a cube needs at least one dimension');
  for (const [name, d] of Object.entries(dimensions)) {
    const at = `dimensions.${name}`;
    const o = obj(d, at);
    keys(o, at, ['sql', 'description', 'kind', 'value_type', 'grains', 'joins', 'params', 'display'], ['sql']);
    str(o.sql, `${at}.sql`);
    if (o.description !== undefined) str(o.description, `${at}.description`);
    if (o.kind !== undefined) oneOf(o.kind, `${at}.kind`, KINDS);
    if (o.value_type !== undefined) oneOf(o.value_type, `${at}.value_type`, VALUE_TYPES);
    if (o.grains !== undefined) list(o.grains, `${at}.grains`, (g, p) => oneOf(g, p, GRAINS));
    check(o.kind !== 'time' || o.grains !== undefined, `${at}.grains`, 'a time dimension lists its grains');
    joinRefs(o, at, joins);
    if (o.params !== undefined) params(o.params, `${at}.params`);
    if (o.display !== undefined) display(o.display, `${at}.display`);
  }

  if (top.modifiers !== undefined) {
    for (const [name, m] of Object.entries(obj(top.modifiers, 'modifiers'))) {
      const at = `modifiers.${name}`;
      const o = obj(m, at);
      keys(o, at, ['class', 'output', 'description', 'params', 'required', 'requires', 'rules'], ['class', 'output', 'description', 'rules']);
      if (o.required !== undefined) list(o.required, `${at}.required`, (r, p) => { check(typeof r === 'string' && r in ((o.params ?? {}) as object), p, 'not one of params'); return r as string; });
      check(o.class === 1, `${at}.class`, 'cube modifiers are class 1 (a row condition or a reformat of the metric)');
      oneOf(o.output, `${at}.output`, OUTPUTS);
      str(o.description, `${at}.description`); str(o.rules, `${at}.rules`);
      if (o.requires !== undefined) list(o.requires, `${at}.requires`, (r, p) => oneOf(r, p, ADDITIVITY));
      if (o.params !== undefined) params(o.params, `${at}.params`);
    }
  }
  return top as unknown as CubeModel;
}
