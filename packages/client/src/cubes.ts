/**
 * Loading a cube directory in a local host: `cubes.yaml` → a `Provider`.
 * Where bytes come from (filesystem, `fetch`) is the `Reader`'s business, so
 * this file imports nothing host-specific.
 */
import type { CubesManifest, Provider } from '@semantic-gate/contract';
import { parse } from 'yaml';

export interface Reader {
  read(location: string): Promise<string>;
  /** `relative` against the location `from` (a file). */
  resolve(from: string, relative: string): string;
  /** Import a JavaScript module by location; free-form providers only. */
  importModule(location: string): Promise<Record<string, unknown>>;
}

export interface LoadedCubes {
  provider: Provider;
  manifest: CubesManifest;
  /** Directory (or URL prefix) of `cubes.yaml`, for the engine's `tables`. */
  dir: string;
}

/** Table name → data file or URL, as written in `cubes.yaml`. */
export type TableDefs = Record<string, string>;

/**
 * `location` is `cubes.yaml` itself or its directory. `rules` is where
 * semtrans' `rules/*.dl` come from; omitted, semtrans reads its own package
 * (node only).
 */
export async function loadCubes(
  location: string,
  reader: Reader,
  options: { rules?: { read(path: string): Promise<string> } } = {},
): Promise<LoadedCubes> {
  const file = /\.ya?ml$/.test(location) ? location : reader.resolve(`${location.replace(/\/+$/, '')}/_`, 'cubes.yaml');
  const manifest = parse(await reader.read(file)) as CubesManifest;
  const dir = file.slice(0, file.lastIndexOf('/') + 1) || './';
  const sources = { read: (path: string) => reader.read(reader.resolve(file, path)) };

  if (manifest.semtrans) {
    const { createSemtrans } = await import('@semantic-gate/semtrans');
    const provider = await createSemtrans({ manifest, cubes: sources, ...(options.rules && { rules: options.rules }) });
    return { provider, manifest, dir };
  }
  if (manifest.module) {
    const mod = await reader.importModule(reader.resolve(file, manifest.module));
    const provider = mod.default as Provider | undefined;
    if (!provider || typeof provider.plan !== 'function') {
      throw new Error(`${manifest.module}: default export is not a Provider`);
    }
    return { provider, manifest, dir };
  }
  throw new Error(`${file}: an \`entrypoint\`-only cube is a process provider; only the native gate can run it`);
}

/**
 * An Iceberg table: its `metadata.json` (read as published), or its directory
 * (a moved table: the extension builds `<dir>/metadata/…` and follows
 * `version-hint.text`, which is how the testbed's marts are read).
 */
export function isIceberg(location: string): boolean {
  return /metadata\.json$/.test(location) || !/\.[a-z0-9]+$/i.test(location.replace(/\/$/, ''));
}

/** The `create view` statement that exposes one manifest table to DuckDB. */
export function tableSql(name: string, location: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const id = `"${name.replace(/"/g, '""')}"`;
  const reader = isIceberg(location)
    ? /metadata\.json$/.test(location)
      ? `iceberg_scan(${q(location)})`
      : `iceberg_scan(${q(location.replace(/\/$/, ''))}, allow_moved_paths = true)`
    : /\.parquet$/.test(location)
      ? `read_parquet(${q(location)})`
      : `read_csv_auto(${q(location)})`;
  return `create or replace view ${id} as select * from ${reader}`;
}
