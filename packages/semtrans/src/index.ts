/**
 * @semantic-gate/semtrans — the semantic layer in Datalog, and the engine
 * under every declarative authoring method.
 *
 * ```text
 *  .dl cube ───────────────────────────────────────┐
 *  .yaml cube ── parseCube ──┐                     │
 *  MetricFlow ── importMetricflow ──┼─ CubeModel ── lower ──► catalog facts
 *  cube.dev ──── importCubedev ─────┘                         │
 *                                                rules/*.dl + facts ── compile (once)
 *  query ── encode ──► query facts ──► program.run ──► plan relations ── render ──► SQL + columns
 * ```
 *
 * Three seams are fixed: `rules/contract.dl` (the query in),
 * `rules/catalog.dl` (cubes in), `rules/plan.dl` (plan, columns, refusals
 * out). Everything between them is rules. The provider is an ordinary
 * contract `Provider`; no host can tell it from a hand-written one.
 */
import { CONTRACT_VERSION } from '@semantic-gate/contract';
import type { CubeSource, CubesManifest, Metadata, Provider } from '@semantic-gate/contract';
import { compile } from '@semantic-gate/datalog';
import type { Program } from '@semantic-gate/datalog';
import { encode } from './encode.ts';
import { importCubedev } from './import/cubedev.ts';
import { importMetricflow } from './import/metricflow.ts';
import { lower } from './lower.ts';
import { metadata } from './metadata.ts';
import type { CubeModel } from './model.ts';
import { parseCube } from './parse.ts';
import { render } from './render.ts';
import type { PlanRelations } from './render.ts';

export type { CubeModel } from './model.ts';
export { parseCube } from './parse.ts';
export { lower } from './lower.ts';
export { importMetricflow } from './import/metricflow.ts';
export { importCubedev } from './import/cubedev.ts';

/** Where sources come from: the filesystem under node, `fetch` in a browser. */
export interface SourceReader {
  read(path: string): Promise<string>;
}

export interface SemtransOptions {
  manifest: CubesManifest;
  /** Reads cube sources, relative to the manifest. */
  cubes: SourceReader;
  /** Reads `rules/*.dl`; default under node: this package's `rules/` directory. */
  rules?: SourceReader;
}

/** The rule files in include order: the three seams, then the layers between them. */
const RULES = [
  'contract.dl', 'catalog.dl', 'plan.dl', 'text.dl', 'vocab.dl', 'resolve.dl', 'filters.dl',
  'time.dl', 'scopes.dl', 'base.dl', 'modifiers.dl', 'final.dl',
];

/** Under node only; the dynamic import keeps the module loadable where there is no `node:fs`. */
async function nodeRules(): Promise<SourceReader> {
  const { readFile } = await import(/* @vite-ignore */ 'node:' + 'fs/promises');
  const dir = new URL('../rules/', import.meta.url);
  return { read: (path) => readFile(new URL(path, dir), 'utf8') };
}

const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const isYaml = (p: string): boolean => /\.ya?ml$/.test(p);

async function sha256(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join('\0'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One cube source → the Datalog it contributes, plus the files it brought in. */
async function load(source: CubeSource, cubes: SourceReader, files: Map<string, string>): Promise<string[]> {
  const read = async (path: string): Promise<string> => {
    const text = await cubes.read(path);
    files.set(path, text);
    return text;
  };
  const models = (ms: CubeModel[], file: string): Promise<string[]> => lowerAll(ms, file, read, files);
  if (typeof source === 'string') {
    const text = await read(source);
    if (!isYaml(source)) return [text];
    return models([parseCube(text, source)], source);
  }
  if ('metricflow' in source) return models(importMetricflow(JSON.parse(await read(source.metricflow))), source.metricflow);
  return models(importCubedev(await read(source.cubedev), source.cubedev), source.cubedev);
}

async function lowerAll(ms: CubeModel[], file: string, read: (p: string) => Promise<string>, files: Map<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const m of ms) {
    out.push(lower(m));
    for (const mod of Object.values(m.modifiers ?? {})) {
      const path = dirname(file) + mod.rules;
      if (!files.has(path) || path === file) out.push(await read(path));
    }
  }
  return out;
}

/** Load every source of the manifest, compile one program, and answer the provider protocol. */
export async function createSemtrans(options: SemtransOptions): Promise<Provider> {
  const rules = options.rules ?? (await nodeRules());
  const files = new Map<string, string>();
  const fragments: string[] = [];
  for (const source of options.manifest.semtrans ?? []) fragments.push(...(await load(source, options.cubes, files)));

  const texts = new Map<string, string>();
  for (const name of RULES) texts.set(name, await rules.read(name));
  fragments.forEach((f, i) => texts.set(`cube-${i}.dl`, f));
  const entry = [...RULES, ...fragments.map((_, i) => `cube-${i}.dl`)].map((n) => `#include "${n}"`).join('\n');
  texts.set('main.dl', entry);
  const program: Program = compile('main.dl', { read: (p) => texts.get(p) ?? '' });

  const catalog = program.run({}) as PlanRelations;
  const errors = (catalog.load_error ?? []).map((t) => String(t[0]));
  if (errors.length) throw new Error(`cubes: ${errors.join('; ')}`);
  const meta: Metadata = metadata(catalog, await sha256([...files.values()]));

  return {
    initialize: () => ({ contract_version: CONTRACT_VERSION, dialects: ['duckdb', 'clickhouse'] }),
    metadata: () => meta,
    plan: (params) => render(program.run(encode(params)) as PlanRelations),
  };
}
