/**
 * Browser host: `fetch` reader and DuckDB-wasm. Data files are fetched by
 * DuckDB itself (HTTP range reads for Parquet and Iceberg), so the data origin
 * must answer CORS.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import { isIceberg, tableSql, type Reader, type TableDefs } from './cubes.ts';
import type { SqlEngine } from './local.ts';

export const fetchReader: Reader = {
  async read(location) {
    const res = await fetch(location);
    if (!res.ok) throw new Error(`${location}: HTTP ${res.status}`);
    return res.text();
  },
  resolve: (from, relative) => new URL(relative, new URL(from, document.baseURI)).href,
  importModule: (location) => import(/* @vite-ignore */ location),
};

export interface WasmOptions {
  /** URL prefix of duckdb-wasm's `dist/` (the `.wasm` and worker files); default: jsDelivr. */
  dist?: string;
}

export async function duckdbWasm(tables: TableDefs = {}, baseUrl = '', options: WasmOptions = {}): Promise<SqlEngine> {
  const dist = new URL(options.dist ?? 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/', document.baseURI).href;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: `${dist}duckdb-browser-mvp.worker.js` },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: `${dist}duckdb-browser-eh.worker.js` },
  });
  // A cross-origin worker script cannot be constructed directly; load it through a same-origin blob.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule);
  URL.revokeObjectURL(workerUrl);
  const iceberg = Object.values(tables).some(isIceberg);
  // Ranged reads only: Iceberg manifests and Parquet footers must not be pulled whole (spike 0016).
  // `open` must precede the first connection.
  if (iceberg) await db.open({ filesystem: { allowFullHTTPReads: false } });
  const conn = await db.connect();
  if (iceberg) await conn.query('install iceberg; load iceberg;');
  for (const [name, file] of Object.entries(tables)) {
    const url = /^https?:\/\//.test(file) ? file : new URL(file, new URL(baseUrl, document.baseURI)).href;
    if (!isIceberg(file)) await db.registerFileURL(url.split('/').pop()!, url, duckdb.DuckDBDataProtocol.HTTP, false);
    await conn.query(tableSql(name, isIceberg(file) ? url : url.split('/').pop()!));
  }
  return {
    async execute(sql) {
      const table = await conn.query(sql);
      return table.toArray().map((row) => Object.values(row.toJSON()) as unknown[]);
    },
  };
}
