/**
 * The catalog relations the rules publish → contract Metadata. Computed once at
 * load from a run with no query.
 */
import type {
  Additivity, DimensionDecl, DimensionDisplay, DimensionKind, Json, Metadata, MetricDecl, MetricDisplay, ModifierDecl, ModifierOutput,
  ParamSchema, ParamsSchema, TimeGrain, ValueType,
} from '@semantic-gate/contract';
import { CONTRACT_VERSION } from '@semantic-gate/contract';
import type { Tuple } from '@semantic-gate/datalog';
import type { PlanRelations } from './render.ts';

type Info = Record<string, string>;

/** Rows `[…, key, value]` whose leading columns equal `lead`, as an object. */
function info(rows: readonly Tuple[], match: (t: Tuple) => boolean, key: number): Info {
  const out: Info = {};
  for (const t of rows) if (match(t)) out[String(t[key])] = String(t[key + 1]);
  return out;
}

function typed(type: string, v: string): Json {
  if (type === 'integer' || type === 'number') return Number(v);
  if (type === 'boolean') return v === 'true';
  return v;
}

/** One owner's parameters as the MOD-001 schema subset. */
function schema(
  props: readonly Tuple[], enums: readonly Tuple[], owned: (t: Tuple) => boolean, at: { param: number; key: number; value: number },
): ParamsSchema | undefined {
  const names = [...new Set(props.filter(owned).map((t) => String(t[at.param])))].sort();
  if (names.length === 0) return undefined;
  const properties: Record<string, ParamSchema> = {};
  const required: string[] = [];
  for (const p of names) {
    const kv = info(props, (t) => owned(t) && t[at.param] === p, at.key);
    const type = kv.type as ParamSchema['type'];
    const s: ParamSchema = { type };
    const values = enums.filter((t) => owned(t) && t[at.param] === p).sort((a, b) => (a[at.param + 1] as number) - (b[at.param + 1] as number));
    if (values.length) s.enum = values.map((t) => typed(type, String(t[at.param + 2])));
    if (kv.minimum !== undefined) s.minimum = Number(kv.minimum);
    if (kv.maximum !== undefined) s.maximum = Number(kv.maximum);
    if (kv.items !== undefined) s.items = { type: kv.items as 'string' };
    if (kv.default !== undefined) s.default = typed(type, kv.default);
    if (kv.description !== undefined) s.description = kv.description;
    if (kv.required === '1') required.push(p);
    properties[p] = s;
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

export function metadata(r: PlanRelations, cubesSha: string): Metadata {
  const rel = (n: string): readonly Tuple[] => r[n] ?? [];
  const displayOf = (cube: string, owner: string): Json | undefined => {
    const t = rel('c_display').find((x) => x[0] === cube && x[1] === owner);
    return t ? (JSON.parse(String(t[2])) as Json) : undefined;
  };
  const dimsOf = (cube: string): string[] => rel('c_dimension').filter((t) => t[0] === cube).map((t) => String(t[1]));

  const metrics: MetricDecl[] = rel('c_metric').map(([cube, name]) => {
    const i = info(rel('c_m_info'), (t) => t[0] === cube && t[1] === name, 2);
    const owner = `m:${name}`;
    const params = schema(rel('c_pa'), rel('c_pa_enum'), (t) => t[0] === cube && t[1] === owner, { param: 2, key: 3, value: 4 });
    const display = displayOf(String(cube), owner);
    return {
      name: String(name),
      description: i.description ?? '',
      value_type: (i.value_type ?? 'number') as ValueType,
      additivity: i.additivity as Additivity,
      dimensions: dimsOf(String(cube)),
      ...(params ? { params } : {}),
      ...(display ? { display: display as MetricDisplay } : {}),
    };
  });

  // a dimension two cubes both declare is listed once, by the first cube's name
  const seen = new Set<string>();
  const dimensions: DimensionDecl[] = [];
  for (const [cube, name] of rel('c_dimension')) {
    if (seen.has(String(name))) continue;
    seen.add(String(name));
    const i = info(rel('c_d_info'), (t) => t[0] === cube && t[1] === name, 2);
    const owner = `d:${name}`;
    const grains = rel('c_d_grain').filter((t) => t[0] === cube && t[1] === name).map((t) => String(t[2])) as TimeGrain[];
    const params = schema(rel('c_pa'), rel('c_pa_enum'), (t) => t[0] === cube && t[1] === owner, { param: 2, key: 3, value: 4 });
    const display = displayOf(String(cube), owner);
    dimensions.push({
      name: String(name),
      description: i.description ?? '',
      kind: i.kind as DimensionKind,
      value_type: i.value_type as ValueType,
      ...(grains.length ? { grains: grains.sort((a, b) => ['day', 'week', 'month', 'quarter', 'year'].indexOf(a) - ['day', 'week', 'month', 'quarter', 'year'].indexOf(b)) } : {}),
      ...(params ? { params } : {}),
      ...(display ? { display: display as DimensionDisplay } : {}),
    });
  }

  const modifiers: ModifierDecl[] = rel('x_mod').map(([name, cls, output, description, origin]) => ({
    name: String(name),
    class: cls as ModifierDecl['class'],
    params: schema(rel('x_pa'), rel('x_pa_enum'), (t) => t[0] === name, { param: 1, key: 2, value: 3 }) ?? { type: 'object', properties: {} },
    requires: rel('x_req').filter((t) => t[0] === name).map((t) => String(t[1])) as Additivity[],
    description: String(description),
    origin: origin as 'base' | 'cube',
    output: output as ModifierOutput,
  }));

  const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : 1);
  return { contract_version: CONTRACT_VERSION, cubes_sha: cubesSha, metrics: metrics.sort(byName), dimensions: dimensions.sort(byName), modifiers: modifiers.sort(byName) };
}
