/**
 * MetricFlow → CubeModel. Input: `target/semantic_manifest.json` from
 * `dbt parse`. A refused construct is named, never approximated.
 *
 * Mapping. A semantic model becomes a cube when some metric lands on it; a
 * model with no metric is only a join target. Foreign entities matching a
 * primary/unique entity of another model become joins (many-to-one), and the
 * dimensions of joined models are exposed on the cube — under their own name
 * unless that clashes, then as `<entity>__<dimension>`. Measures become
 * metrics only through the metrics that use them (`simple`; `ratio` is
 * `num / nullif(den, 0)`; `derived` keeps its expression with `{metric}`
 * holes). A time dimension becomes `date_trunc('{time_grain}', …)` over the
 * grains from its granularity upward, written for DuckDB/PostgreSQL.
 *
 * Refused: `cumulative` (it is the `cumulative` modifier of a query),
 * `conversion`, metric/measure filters, offsets, `fill_nulls_with`, medians
 * and percentiles, SCD validity, a measure on a time dimension other than the
 * model's default, granularities finer than a day, metrics spanning cubes.
 * Ignored (no effect on values): saved queries, project configuration,
 * `meta` keys other than the display hints below.
 *
 * Display hints MetricFlow has no field for travel in `config.meta` (or
 * `meta`): metrics take `unit`, `format`, `decimals`, `good_when`, `color`,
 * `value_type`; dimensions and entities take `kind`, `value_type`, `order`,
 * `colors`, and time dimensions `default_grain` (MetricFlow asks for a
 * granularity per query and has no default).
 * `non_additive_dimension` is carried as the `semi_additive` label only; its
 * window rule is not part of the CubeModel.
 */
import type { CubeModel, Dimension, Join, Metric } from '../model.ts';
import { aliasFor, dimensionMeta, grainsFrom, metricMeta, qualify } from './sql.ts';

type Obj = Record<string, any>;

const AGGS: Record<string, 'sum' | 'count' | 'count_distinct' | 'min' | 'max' | 'avg'> = {
  sum: 'sum',
  count: 'count',
  count_distinct: 'count_distinct',
  min: 'min',
  max: 'max',
  average: 'avg',
};

interface Entity {
  name: string;
  type: string;
  expr: string;
}

interface Model {
  raw: Obj;
  name: string;
  table: string;
  entities: Entity[];
  measures: Map<string, Obj>;
  dims: Obj[];
  timeDim: string | undefined;
}

export function importMetricflow(manifest: unknown): CubeModel[] {
  const root = obj(manifest, 'manifest');
  const models = new Map<string, Model>();
  for (const [i, sm] of arr(root.semantic_models, 'semantic_models').entries()) {
    const where = `semantic_models[${sm?.name ?? i}]`;
    const name = str(sm.name, `${where}.name`);
    const rel = obj(sm.node_relation, `${where}.node_relation`);
    models.set(name, {
      raw: sm,
      name,
      table: rel.relation_name ?? [rel.schema_name, rel.alias].filter(Boolean).join('.'),
      entities: arr(sm.entities, `${where}.entities`).map((e) => ({ name: e.name, type: e.type, expr: e.expr ?? e.name })),
      measures: new Map(arr(sm.measures, `${where}.measures`).map((m) => [m.name, m])),
      dims: arr(sm.dimensions, `${where}.dimensions`),
      timeDim: sm.defaults?.agg_time_dimension,
    });
  }

  // metric name → owning model and CubeModel metric
  const metrics = new Map<string, { model: Model; metric: Metric }>();
  const raws = new Map<string, Obj>(arr(root.metrics, 'metrics').map((m) => [m.name, m]));
  const resolving = new Set<string>();
  const metricOf = (name: string, from: string): { model: Model; metric: Metric } => {
    const done = metrics.get(name);
    if (done) return done;
    const m = raws.get(name) ?? fail(from, `metric ${name} is not defined`);
    if (resolving.has(name)) fail(`metrics[${name}]`, 'metric definitions are circular');
    resolving.add(name);
    const r = buildMetric(m, models, metricOf);
    resolving.delete(name);
    metrics.set(name, r);
    return r;
  };
  for (const name of raws.keys()) metricOf(name, 'metrics');
  // A measure with create_metric: true is queryable under its own name.
  for (const model of models.values()) {
    for (const ms of model.measures.values()) {
      if (ms.create_metric === true && !metrics.has(ms.name))
        metrics.set(ms.name, { model, metric: measureMetric(model, ms, ms, `semantic_models[${model.name}].measures[${ms.name}]`) });
    }
  }

  const cubes: CubeModel[] = [];
  for (const model of models.values()) {
    const own = [...metrics].filter(([, v]) => v.model === model);
    if (own.length === 0) continue;
    cubes.push(buildCube(model, models, own.map(([name, v]) => [name, v.metric])));
  }
  return cubes;
}

// ---- metrics ----------------------------------------------------------------

function buildMetric(
  m: Obj,
  models: Map<string, Model>,
  metricOf: (name: string, from: string) => { model: Model; metric: Metric },
): { model: Model; metric: Metric } {
  const where = `metrics[${m.name}]`;
  if (nonEmptyFilter(m.filter)) fail(where, 'metric filters (where) have no CubeModel equivalent');
  if (m.time_granularity) fail(where, 'metric time_granularity is not supported');
  const tp = m.type_params ?? {};
  const base = common(m);
  const sameModel = (names: string[]): Model => {
    const owners = names.map((n) => metricOf(n, where).model);
    if (new Set(owners).size > 1) fail(where, `inputs ${names.join(', ')} belong to different semantic models`);
    return owners[0]!;
  };
  switch (m.type) {
    case 'simple': {
      const ref = tp.measure ?? fail(where, 'simple metric without type_params.measure');
      if (nonEmptyFilter(ref.filter)) fail(where, 'measure filters (where) have no CubeModel equivalent');
      if (ref.join_to_timespine || ref.fill_nulls_with != null) fail(where, 'join_to_timespine / fill_nulls_with are not supported');
      const model = [...models.values()].find((x) => x.measures.has(ref.name)) ?? fail(where, `measure ${ref.name} is not defined`);
      return { model, metric: measureMetric(model, model.measures.get(ref.name)!, m, where) };
    }
    case 'ratio': {
      const num = tp.numerator ?? fail(where, 'ratio without numerator');
      const den = tp.denominator ?? fail(where, 'ratio without denominator');
      if (nonEmptyFilter(num.filter) || nonEmptyFilter(den.filter)) fail(where, 'ratio input filters have no CubeModel equivalent');
      const model = sameModel([num.name, den.name]);
      return { model, metric: { derived: `{${num.name}} / nullif({${den.name}}, 0)`, ...base } };
    }
    case 'derived': {
      const inputs = arr(tp.metrics, `${where}.type_params.metrics`);
      for (const i of inputs) {
        if (i.offset_window || i.offset_to_grain) fail(where, 'offset_window / offset_to_grain have no CubeModel equivalent');
        if (nonEmptyFilter(i.filter)) fail(where, 'input metric filters have no CubeModel equivalent');
      }
      const model = sameModel(inputs.map((i) => i.name));
      const names = new Map(inputs.map((i) => [i.alias ?? i.name, i.name]));
      const derived = str(tp.expr, `${where}.type_params.expr`).replace(/'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*/g, (t) =>
        t.startsWith("'") || !names.has(t) ? t : `{${names.get(t)}}`,
      );
      return { model, metric: { derived, ...base } };
    }
    case 'cumulative':
      return fail(where, 'cumulative metrics are the `cumulative` modifier of a query, not a metric');
    case 'conversion':
      return fail(where, 'conversion metrics have no CubeModel equivalent');
    default:
      return fail(where, `metric type ${JSON.stringify(m.type)} is not supported`);
  }
}

/** The part every metric carries: description and display. `meta` hints override nothing MetricFlow can say. */
function common(m: Obj): { description?: string; display?: Obj; value_type?: any } {
  const hints = metricMeta(m.config?.meta ?? m.meta);
  const { value_type, ...disp } = hints;
  const display: Obj = { ...(m.label ? { label: m.label } : {}), ...disp };
  return {
    ...(m.description ? { description: m.description } : {}),
    ...(value_type ? { value_type } : {}),
    ...(Object.keys(display).length ? { display } : {}),
  };
}

function measureMetric(model: Model, ms: Obj, named: Obj, where: string): Metric {
  const agg = AGGS[ms.agg] ?? fail(where, `aggregation ${JSON.stringify(ms.agg)} is not supported`);
  if (ms.agg_params && Object.values(ms.agg_params).some((v) => v != null && v !== false)) fail(where, 'agg_params are not supported');
  if (ms.agg_time_dimension && ms.agg_time_dimension !== model.timeDim)
    fail(where, `measure ${ms.name} aggregates over time dimension ${ms.agg_time_dimension}, not the model default`);
  // count(1) is count(*): the CubeModel spells that as no expr.
  const expr = agg === 'count' && String(ms.expr).trim() === '1' ? undefined : qualify(String(ms.expr ?? ms.name), 'o', where);
  const additivity = ms.non_additive_dimension
    ? 'semi_additive'
    : agg === 'count_distinct' || agg === 'avg'
      ? 'non_reaggregable'
      : undefined;
  const c = common(named);
  return {
    agg,
    ...(expr === undefined ? {} : { expr }),
    ...(agg === 'count' || agg === 'count_distinct' ? { value_type: 'integer' as const } : {}),
    ...(additivity ? { additivity } : {}),
    ...c,
  };
}

// ---- cubes ------------------------------------------------------------------

function buildCube(model: Model, models: Map<string, Model>, metrics: [string, Metric][]): CubeModel {
  const where = `semantic_models[${model.name}]`;
  const taken = new Set(['o']);
  // Breadth-first over foreign → primary/unique entities.
  const joins: Record<string, Join> = {};
  const reached: { model: Model; key: string; via: string; alias: string }[] = [];
  const aliasOf = new Map<Model, string>([[model, 'o']]);
  const queue: Model[] = [model];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const fk of from.entities.filter((e) => e.type === 'foreign')) {
      const targets = [...models.values()].filter((t) => t !== from && t.entities.some((e) => e.name === fk.name && (e.type === 'primary' || e.type === 'unique')));
      if (targets.length === 0) continue;
      if (targets.length > 1) fail(where, `entity ${fk.name} is the primary entity of several models: ${targets.map((t) => t.name).join(', ')}`);
      const to = targets[0]!;
      if (aliasOf.has(to)) continue;
      const alias = aliasFor(to.name, taken);
      taken.add(alias);
      aliasOf.set(to, alias);
      const pk = to.entities.find((e) => e.name === fk.name)!;
      joins[to.name] = {
        table: to.table,
        alias,
        on: `${qualify(fk.expr, aliasOf.get(from)!, where)} = ${qualify(pk.expr, alias, where)}`,
        ...(from === model ? {} : { requires: [from.name] }),
      };
      reached.push({ model: to, key: to.name, via: fk.name, alias });
      queue.push(to);
    }
  }

  const dimensions: Record<string, Dimension> = {};
  for (const e of model.raw.entities as Obj[]) {
    const ent = { ...e, type: 'categorical', config: { meta: { ...e.config?.meta, kind: 'entity' } } };
    dimensions[e.name] = dimension(ent, 'o', where, undefined);
  }
  for (const d of model.dims) dimensions[d.name] = dimension(d, 'o', where, undefined);
  // Joined dimensions: own name unless it clashes with another dimension of the cube.
  const count = new Map<string, number>();
  for (const n of Object.keys(dimensions)) count.set(n, 1);
  for (const r of reached) for (const d of r.model.dims) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  for (const r of reached) {
    for (const d of r.model.dims) {
      const name = (count.get(d.name) ?? 0) > 1 ? `${r.via}__${d.name}` : d.name;
      if (name in dimensions) fail(where, `dimension name ${name} is ambiguous`);
      dimensions[name] = dimension(d, r.alias, `semantic_models[${r.model.name}]`, r.key);
    }
  }

  return {
    cube: model.name,
    table: model.table,
    alias: 'o',
    ...(model.raw.description ? { description: model.raw.description } : {}),
    ...(Object.keys(joins).length ? { joins } : {}),
    metrics: Object.fromEntries(metrics),
    dimensions,
  };
}

/** The grain a query gets without asking: a `default_grain` hint, else the dimension's own granularity. */
export function defaultGrain(hint: string | undefined, grains: string[], own: string, where: string): string {
  if (hint === undefined) return own;
  if (!grains.includes(hint)) fail(where, `default_grain ${hint} is not one of ${grains.join(', ')}`);
  return hint;
}

function dimension(d: Obj, alias: string, where: string, join: string | undefined): Dimension {
  const at = `${where}.dimensions[${d.name}]`;
  if (d.validity_params) fail(at, 'validity_params (slowly changing dimensions) are not supported');
  const sql = qualify(String(d.expr ?? d.name), alias, at);
  const hints = dimensionMeta(d.config?.meta ?? d.meta);
  const display: Obj = { ...(d.label ? { label: d.label } : {}), ...(hints.order ? { order: hints.order } : {}), ...(hints.colors ? { colors: hints.colors } : {}) };
  const common: Partial<Omit<Dimension, "sql">> = {
    ...(d.description ? { description: d.description } : {}),
    ...(join ? { joins: [join] } : {}),
    ...(Object.keys(display).length ? { display } : {}),
  };
  if (d.type === 'time') {
    const gran = d.type_params?.time_granularity ?? fail(at, 'time dimension without time_granularity');
    const grains = grainsFrom(gran, at);
    return {
      sql: `date_trunc('{time_grain}', ${sql})`,
      kind: 'time',
      grains,
      params: { time_grain: { type: 'string', enum: [...grains], default: defaultGrain(hints.default_grain, grains, gran, at) } },
      ...common,
    };
  }
  if (d.type !== 'categorical') fail(at, `dimension type ${JSON.stringify(d.type)} is not supported`);
  return {
    sql,
    ...(hints.kind ? { kind: hints.kind as NonNullable<Dimension['kind']> } : {}),
    ...(hints.value_type ? { value_type: hints.value_type as NonNullable<Dimension['value_type']> } : {}),
    ...common,
  };
}

// ---- helpers ----------------------------------------------------------------

function fail(where: string, msg: string): never {
  throw new Error(`metricflow: ${where}: ${msg}`);
}

function obj(v: unknown, where: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(where, 'expected an object');
  return v as Obj;
}

function arr(v: unknown, where: string): Obj[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(where, 'expected an array');
  return v as Obj[];
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(where, 'expected a string');
  return v as string;
}

const nonEmptyFilter = (f: Obj | null | undefined): boolean => !!f && (f.where_filters?.length ?? 0) > 0;
