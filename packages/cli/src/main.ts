#!/usr/bin/env node
/**
 * semantic-gate-js — every client capability as JSON on stdout, plus the
 * stdio provider the native gate spawns (`serve`) and an MCP server (`mcp`).
 *
 * ```text
 * semantic-gate-js meta|query|chart|explain  (--gate URL --ns NAME [--token T] | --cubes DIR)
 *                                            [-q '<json>' | --query FILE | < stdin]
 * semantic-gate-js serve DIR                 provider JSON-RPC on stdio
 * semantic-gate-js mcp  (--gate … | --cubes …)
 * semantic-gate-js import metricflow|cubedev FILE     CubeModel YAML
 * semantic-gate-js lower FILE.yaml                    Datalog catalog facts
 * ```
 *
 * Each data command prints exactly one JSON document; a refusal prints the
 * `Envelope` and exits 1. Nothing here decides anything the client or viz does not.
 */
import { readFileSync } from 'node:fs';
import { createClient, GateError, httpTransport, loadCubes, localTransport, type Client } from '@semantic-gate/client';
import { duckdbNode, nodeReader } from '@semantic-gate/client/node';
import type { Envelope, SemanticQuery } from '@semantic-gate/contract';
import { mcp } from './mcp.ts';
import { serve } from './serve.ts';

export interface Flags {
  gate?: string;
  ns?: string;
  token?: string;
  cubes?: string;
  q?: string;
  query?: string;
}

const VALUE_FLAGS: Record<string, keyof Flags> = {
  '--gate': 'gate', '--ns': 'ns', '--token': 'token', '--cubes': 'cubes', '-q': 'q', '--query': 'query',
};

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const key = VALUE_FLAGS[a];
    if (key) {
      const v = argv[++i];
      if (v === undefined) throw new Usage(`${a} needs a value`);
      flags[key] = v;
    } else if (a.startsWith('-')) throw new Usage(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
}

class Usage extends Error {}

/** A client over REST (`--gate`/`--ns`) or fully local (`--cubes`, DuckDB). */
export async function connect(flags: Flags): Promise<Client> {
  if (flags.gate) {
    if (!flags.ns) throw new Usage('--gate needs --ns');
    return createClient(httpTransport({ gate: flags.gate, namespace: flags.ns, ...(flags.token && { token: flags.token }) }));
  }
  if (flags.cubes) {
    const { provider, manifest, dir } = await loadCubes(flags.cubes, nodeReader);
    const engine = await duckdbNode(manifest.tables, dir);
    return createClient(localTransport({ provider, engine }));
  }
  throw new Usage('give --gate URL --ns NAME, or --cubes DIR');
}

function readQuery(flags: Flags): SemanticQuery {
  const text = flags.q ?? (flags.query ? readFileSync(flags.query, 'utf8') : process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));
  if (!text.trim()) throw new Usage('give a query: -q \'<json>\', --query FILE, or on stdin');
  try {
    return JSON.parse(text) as SemanticQuery;
  } catch (e) {
    throw new Usage(`query is not JSON: ${(e as Error).message}`);
  }
}

const print = (doc: unknown) => process.stdout.write(`${JSON.stringify(doc)}\n`);

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  try {
    switch (command) {
      case 'meta': print(await (await connect(flags)).metadata()); return 0;
      case 'query': print(await (await connect(flags)).query(readQuery(flags))); return 0;
      case 'explain': print(await (await connect(flags)).explain(readQuery(flags))); return 0;
      case 'chart': {
        const { response, chart } = await (await connect(flags)).chart(readQuery(flags));
        print({ response, chart });
        return 0;
      }
      case 'serve': return await serve(rest[0] ?? '.');
      case 'mcp': return await mcp(await connect(flags));
      case 'import': return await importModel(rest[0], rest[1]);
      case 'lower': return await lowerFile(rest[0]);
      default: throw new Usage('commands: meta | query | chart | explain | serve DIR | mcp | import metricflow|cubedev FILE | lower FILE');
    }
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`semantic-gate-js: ${e.message}\n`);
      return 2;
    }
    const envelope: Envelope =
      e instanceof GateError ? e.envelope : { code: 'internal', message: (e as Error).message, request_id: '' };
    print(envelope);
    return 1;
  }
}

async function importModel(kind: string | undefined, file: string | undefined): Promise<number> {
  if ((kind !== 'metricflow' && kind !== 'cubedev') || !file) throw new Usage('import metricflow|cubedev FILE');
  const { importCubedev, importMetricflow } = await import('@semantic-gate/semtrans');
  const { stringify } = await import('yaml');
  const text = readFileSync(file, 'utf8');
  const models = kind === 'metricflow' ? importMetricflow(JSON.parse(text)) : importCubedev(text, file);
  process.stdout.write(models.map((m) => stringify(m)).join('---\n'));
  return 0;
}

async function lowerFile(file: string | undefined): Promise<number> {
  if (!file) throw new Usage('lower FILE.yaml');
  const { lower, parseCube } = await import('@semantic-gate/semtrans');
  process.stdout.write(lower(parseCube(readFileSync(file, 'utf8'), file)));
  return 0;
}

process.exitCode = await run(process.argv.slice(2));
