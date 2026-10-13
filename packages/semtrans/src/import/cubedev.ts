/**
 * cube.dev data model (YAML) → CubeModel. A refused construct is named, never
 * approximated. JavaScript models are out: they are code, not data.
 *
 * Mapping. A cube with measures becomes a CubeModel; a cube without measures
 * is only a join target. `joins` (`many_to_one`/`one_to_one`, or their old
 * names `belongs_to`/`has_one`) become joins, and the dimensions of the
 * directly joined cubes are exposed on the cube — under their own name unless
 * that clashes, then as `<join>__<dimension>`. `{CUBE}`/`{TABLE}` become the
 * cube's alias; `{dim}`/`{CUBE.dim}` inline that dimension's SQL;
 * `{other.dim}` inlines a joined cube's dimension and requires its join; in a
 * `number` measure `{measure}` stays a `{measure}` hole of a derived metric.
 * `count`, `sum`, `avg`, `min`, `max`, `count_distinct` map to the aggregates
 * of the same name (`filters` → `filter`); a `number` measure with no measure
 * reference is a raw aggregate expression. A time dimension becomes
 * `date_trunc('{time_grain}', …)` over every grain, written for
 * DuckDB/PostgreSQL; cube.dev has no default grain, so it is `day` unless
 * `meta.default_grain` says otherwise. `primary_key` dimensions are entities.
 *
 * Ignored, because they change no value: caching (`refresh_key`,
 * `pre_aggregations`), access policy (the gate authorises elsewhere), and
 * presentation-only keys (`public`, `shown`, `title` on cubes, `drill_members`,
 * dimension `format`, `data_source`, `sql_alias`). Refused: `views`,
 * `extends`, `segments`, `one_to_many` joins, `sub_query`, `case`, geo
 * dimensions, `count_distinct_approx`, `running_total`, rolling windows,
 * custom granularities, templating (`{% %}`, `{{ }}`) and context references
 * (`FILTER_PARAMS`, `SECURITY_CONTEXT`, …), references through more than one
 * join.
 *
 * Display hints cube.dev has no field for travel in `meta`: measures take
 * `unit`, `format`, `decimals`, `good_when`, `color`, `value_type`;
 * dimensions take `kind`, `value_type`, `order`, `colors`, `default_grain`.
 * Measure `format: percent|currency` and `title` map to display directly.
 */
import { parse } from 'yaml';
import type { CubeModel, Dimension, Join, Metric } from '../model.ts';
import { GRAINS, aliasFor, dimensionMeta, metricMeta, qualify } from './sql.ts';

type Obj = Record<string, any>;

const IGNORED_CUBE = new Set(['public', 'shown', 'data_source', 'sql_alias', 'refresh_key', 'pre_aggregations', 'access_policy', 'meta', 'title']);
const CUBE_KEYS = new Set(['name', 'sql_table', 'sql', 'description', 'joins', 'dimensions', 'measures', ...IGNORED_CUBE]);
const IGNORED_MEMBER = new Set(['public', 'shown', 'meta', 'drill_members', 'alias']);
const DIM_KEYS = new Set(['name', 'sql', 'type', 'title', 'description', 'primary_key', 'format', ...IGNORED_MEMBER]);
const MEASURE_KEYS = new Set(['name', 'sql', 'type', 'title', 'description', 'filters', 'format', ...IGNORED_MEMBER]);
const JOIN_KINDS = new Set(['many_to_one', 'one_to_one', 'belongs_to', 'has_one']);
const AGGS: Record<string, 'sum' | 'count' | 'count_distinct' | 'min' | 'max' | 'avg'> = {
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count_distinct: 'count_distinct',
};

interface Cube {
  raw: Obj;
  name: string;
  table: string;
  dims: Map<string, Obj>;
  measures: Map<string, Obj>;
}

export function importCubedev(text: string, file: string): CubeModel[] {
  if (/^\s*(cube|view)\s*\(/m.test(text) || /^\s*(import|const|module\.exports)\b/m.test(text)) fail(file, 'JavaScript models are not supported (use the YAML data model format)');
  if (/\{%|\{\{/.test(text)) fail(file, 'templating ({% %}, {{ }}) is not supported');
  let root: Obj;
  try {
    root = parse(text) as Obj;
  } catch (e) {
    throw new Error(`cubedev: ${file}: ${(e as Error).message}`);
  }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.cubes)) fail(file, 'expected a top-level `cubes:` list (JavaScript models are not supported)');
  if (root.views !== undefined) fail(file, '`views` are not supported');

  const cubes = new Map<string, Cube>();
  for (const raw of root.cubes as Obj[]) {
    const name = raw?.name;
    if (typeof name !== 'string') fail(file, 'a cube without a name');
    const where = `${file}: cube ${name}`;
    for (const k of Object.keys(raw)) {
      if (k === 'extends') fail(where, '`extends` is not supported');
      if (k === 'segments') fail(where, '`segments` are not supported');
      if (!CUBE_KEYS.has(k)) fail(where, `unknown cube property ${k}`);
    }
    if ((raw.sql_table === undefined) === (raw.sql === undefined)) fail(where, 'exactly one of sql_table and sql is required');
    for (const d of raw.dimensions ?? []) if (/{\s*(FILTER_PARAMS|SECURITY_CONTEXT|COMPILE_CONTEXT|SQL_UTILS|USER_CONTEXT)/.test(JSON.stringify(d))) fail(where, `dimension ${d.name}: context references are not supported`);
    cubes.set(name, {
      raw,
      name,
      table: raw.sql_table !== undefined ? String(raw.sql_table) : `(${String(raw.sql).trim()})`,
      dims: new Map((raw.dimensions ?? []).map((d: Obj) => [d.name, d])),
      measures: new Map((raw.measures ?? []).map((m: Obj) => [m.name, m])),
    });
  }

  const out: CubeModel[] = [];
  for (const cube of cubes.values()) if (cube.measures.size > 0) out.push(build(cube, cubes, file));
  return out;
}

/** What `{…}` references resolve against while one member's SQL is rewritten. */
interface Cx {
  cube: Cube;
  alias: string;
  /** Direct joins of the cube being built: name → cube and alias. Empty inside an inlined joined dimension. */
  joins: Map<string, { cube: Cube; alias: string }>;
  used: Set<string>;
  /** Members being inlined, to catch a dimension that references itself. */
  stack: string[];
  where: string;
}

function build(cube: Cube, cubes: Map<string, Cube>, file: string): CubeModel {
  const where = `${file}: cube ${cube.name}`;
  const taken = new Set(['o']);
  const joinMap = new Map<string, { cube: Cube; alias: string }>();
  const joins: Record<string, Join> = {};
  for (const j of cube.raw.joins ?? []) {
    const at = `${where}: join ${j.name}`;
    const target = cubes.get(j.name) ?? fail(at, 'joins a cube that is not defined');
    if (!JOIN_KINDS.has(j.relationship)) fail(at, `relationship ${JSON.stringify(j.relationship)} is not supported (only many_to_one and one_to_one)`);
    const alias = aliasFor(target.name, taken);
    taken.add(alias);
    joinMap.set(j.name, { cube: target, alias });
  }
  for (const j of cube.raw.joins ?? []) {
    const { cube: target, alias } = joinMap.get(j.name)!;
    const cx: Cx = { cube, alias: 'o', joins: joinMap, used: new Set(), stack: [], where: `${where}: join ${j.name}` };
    joins[j.name] = { table: target.table, alias, on: substitute(String(j.sql), cx, 'join') };
  }

  const dimensions: Record<string, Dimension> = {};
  for (const d of cube.dims.values()) dimensions[d.name] = dimension(d, cube, 'o', joinMap, undefined, where);
  const count = new Map<string, number>();
  for (const n of Object.keys(dimensions)) count.set(n, 1);
  for (const [, j] of joinMap) for (const n of j.cube.dims.keys()) count.set(n, (count.get(n) ?? 0) + 1);
  for (const [key, j] of joinMap) {
    for (const d of j.cube.dims.values()) {
      const name = (count.get(d.name) ?? 0) > 1 ? `${key}__${d.name}` : d.name;
      if (name in dimensions) fail(where, `dimension name ${name} is ambiguous`);
      dimensions[name] = dimension(d, j.cube, j.alias, new Map(), key, `${file}: cube ${j.cube.name}`);
    }
  }

  const metrics: Record<string, Metric> = {};
  for (const m of cube.measures.values()) metrics[m.name] = measure(m, cube, joinMap, where);

  return {
    cube: cube.name,
    table: cube.table,
    alias: 'o',
    ...(cube.raw.description ? { description: String(cube.raw.description) } : {}),
    ...(Object.keys(joins).length ? { joins } : {}),
    metrics,
    dimensions,
  };
}

function dimension(
  d: Obj,
  cube: Cube,
  alias: string,
  joinMap: Map<string, { cube: Cube; alias: string }>,
  joinKey: string | undefined,
  where: string,
): Dimension {
  const at = `${where}: dimension ${d.name}`;
  for (const k of Object.keys(d)) {
    if (k === 'case' || k === 'sub_query' || k === 'granularities' || k === 'latitude' || k === 'longitude') fail(at, `\`${k}\` is not supported`);
    if (!DIM_KEYS.has(k)) fail(at, `unknown dimension property ${k}`);
  }
  if (d.type === 'geo') fail(at, 'geo dimensions (latitude/longitude points) are not supported');
  const cx: Cx = { cube, alias, joins: joinMap, used: new Set(), stack: [], where: at };
  const sql = substitute(qualify(String(d.sql ?? d.name), alias, at), cx, 'dim');
  const hints = dimensionMeta(d.meta);
  const joins = [...(joinKey ? [joinKey] : []), ...cx.used].filter((j, i, a) => a.indexOf(j) === i);
  const display: Obj = { ...(d.title ? { label: d.title } : {}), ...(hints.order ? { order: hints.order } : {}), ...(hints.colors ? { colors: hints.colors } : {}) };
  const common: Partial<Omit<Dimension, 'sql'>> = {
    ...(d.description ? { description: String(d.description) } : {}),
    ...(joins.length ? { joins } : {}),
    ...(Object.keys(display).length ? { display } : {}),
  };
  if (d.type === 'time') {
    const def = hints.default_grain ?? 'day';
    if (!GRAINS.includes(def as any)) fail(at, `default_grain ${def} is not one of ${GRAINS.join(', ')}`);
    return {
      sql: `date_trunc('{time_grain}', ${sql})`,
      kind: 'time',
      grains: [...GRAINS],
      params: { time_grain: { type: 'string', enum: [...GRAINS], default: def } },
      ...common,
    };
  }
  const base: Partial<Omit<Dimension, 'sql'>> =
    d.type === 'number' ? { kind: 'number', value_type: 'number' } : d.type === 'boolean' ? { value_type: 'boolean' } : d.type === 'string' || d.type === undefined ? {} : fail(at, `dimension type ${JSON.stringify(d.type)} is not supported`);
  if (d.primary_key === true) base.kind = 'entity';
  if (hints.kind) base.kind = hints.kind as NonNullable<Dimension['kind']>;
  if (hints.value_type) base.value_type = hints.value_type as NonNullable<Dimension['value_type']>;
  return { sql, ...base, ...common };
}

function measure(m: Obj, cube: Cube, joinMap: Map<string, { cube: Cube; alias: string }>, where: string): Metric {
  const at = `${where}: measure ${m.name}`;
  for (const k of Object.keys(m)) {
    if (k === 'rolling_window') fail(at, 'rolling windows are not supported');
    if (!MEASURE_KEYS.has(k)) fail(at, `unknown measure property ${k}`);
  }
  const hints = metricMeta(m.meta);
  const { value_type, ...disp } = hints;
  if (m.format !== undefined) {
    if (m.format !== 'percent' && m.format !== 'currency') fail(at, `format ${JSON.stringify(m.format)} is not supported`);
    disp.format = m.format;
  }
  const display: Obj = { ...(m.title ? { label: m.title } : {}), ...disp };
  const cx: Cx = { cube, alias: 'o', joins: joinMap, used: new Set(), stack: [], where: at };
  const filters = (m.filters ?? []).map((f: Obj) => substitute(qualify(String(f.sql), 'o', at), cx, 'dim'));
  const base = {
    ...(m.description ? { description: String(m.description) } : {}),
    ...(value_type ? { value_type } : {}),
    ...(Object.keys(display).length ? { display } : {}),
  } as Partial<Metric>;
  const finish = <T extends Metric>(metric: T): T => (cx.used.size ? { ...metric, joins: [...cx.used] } : metric);

  if (m.type === 'number') {
    if (filters.length) fail(at, '`filters` on a number measure are not supported');
    const sql = substitute(qualify(String(m.sql), 'o', at), cx, 'number');
    return finish(/\{[A-Za-z_]\w*\}/.test(sql) ? { derived: sql, ...base } : { sql, additivity: 'non_reaggregable', ...base });
  }
  const agg = AGGS[m.type] ?? fail(at, `measure type ${JSON.stringify(m.type)} is not supported`);
  if (agg === 'count' && m.sql !== undefined) fail(at, 'a count measure takes no sql (use count_distinct)');
  if (agg !== 'count' && m.sql === undefined) fail(at, `a ${agg} measure needs sql`);
  const additivity = agg === 'count_distinct' || agg === 'avg' ? 'non_reaggregable' : undefined;
  return finish({
    agg,
    ...(agg === 'count' ? {} : { expr: substitute(qualify(String(m.sql), 'o', at), cx, 'dim') }),
    ...(filters.length ? { filter: filters.length === 1 ? filters[0] : filters.map((f: string) => `(${f})`).join(' and ') } : {}),
    ...(agg === 'count' || agg === 'count_distinct' ? { value_type: 'integer' as const } : {}),
    ...(additivity ? { additivity } : {}),
    ...base,
  });
}

type Mode = 'dim' | 'number' | 'join';

/** Replace `{…}` references in already-qualified SQL. */
function substitute(sql: string, cx: Cx, mode: Mode): string {
  return sql.replace(/\{([^{}]*)\}/g, (whole, raw: string) => {
    const ref = raw.trim();
    if (ref === 'CUBE' || ref === 'TABLE') return cx.alias;
    const parts = ref.split('.');
    if (parts.length > 2) fail(cx.where, `reference {${ref}} goes through more than one join`);
    const [head, tail] = parts as [string, string | undefined];
    if (tail === undefined && cx.joins.has(head) && !cx.cube.dims.has(head) && !cx.cube.measures.has(head)) {
      if (mode !== 'join') fail(cx.where, `reference {${ref}} names a joined cube, not a member`);
      return cx.joins.get(head)!.alias;
    }
    if (/^[A-Z][A-Z_]+$/.test(head) && head !== 'CUBE') fail(cx.where, `reference {${ref}} is not supported`);
    const own = head === 'CUBE' || head === cx.cube.name ? tail : tail === undefined ? head : undefined;
    if (own !== undefined) return member(cx.cube, own, cx, mode, whole);
    // {other.member}: a dimension of a directly joined cube
    const j = cx.joins.get(head) ?? fail(cx.where, `reference {${ref}}: ${head} is neither this cube nor one of its joins`);
    const dim = j.cube.dims.get(tail!) ?? fail(cx.where, `reference {${ref}}: ${head} has no dimension ${tail} (measures cannot be referenced across cubes)`);
    cx.used.add(head);
    const inner: Cx = { cube: j.cube, alias: j.alias, joins: new Map(), used: new Set(), stack: cx.stack, where: cx.where };
    return wrap(substitute(qualify(String(dim.sql ?? dim.name), j.alias, cx.where), inner, 'dim'));
  });
}

function member(cube: Cube, name: string, cx: Cx, mode: Mode, whole: string): string {
  if (cube.measures.has(name)) {
    if (mode !== 'number') fail(cx.where, `reference ${whole}: a measure can only be referenced from a number measure`);
    if (cube !== cx.cube) fail(cx.where, `reference ${whole}: measures cannot be referenced across cubes`);
    return `{${name}}`;
  }
  const dim = cube.dims.get(name) ?? fail(cx.where, `reference ${whole}: ${cube.name} has no member ${name}`);
  if (mode === 'number') fail(cx.where, `reference ${whole}: a number measure can only reference measures`);
  const key = `${cube.name}.${name}`;
  if (cx.stack.includes(key)) fail(cx.where, `dimension ${key} references itself`);
  cx.stack.push(key);
  const sql = wrap(substitute(qualify(String(dim.sql ?? dim.name), cx.alias, cx.where), cx, 'dim'));
  cx.stack.pop();
  return sql;
}

const wrap = (sql: string) => (/^[\w.]+$/.test(sql) ? sql : `(${sql})`);

function fail(where: string, msg: string): never {
  throw new Error(`cubedev: ${where}: ${msg}`);
}
