/** Node host: filesystem reader and DuckDB through `@duckdb/node-api`, in memory. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { isIceberg, tableSql, type Reader, type TableDefs } from './cubes.ts';
import type { SqlEngine } from './local.ts';

export const nodeReader: Reader = {
  read: (location) => readFile(location, 'utf8'),
  resolve: (from, relative) => resolve(dirname(from), relative),
  importModule: (location) => import(pathToFileURL(location).href),
};

const isUrl = (s: string) => /^https?:\/\//.test(s);

/** One view per manifest table; relative files resolve against `baseDir`. */
export async function duckdbNode(tables: TableDefs = {}, baseDir = '.'): Promise<SqlEngine> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const iceberg = Object.values(tables).some(isIceberg);
  if (iceberg) await conn.run('install iceberg; load iceberg;');
  for (const [name, file] of Object.entries(tables)) {
    await conn.run(tableSql(name, isUrl(file) ? file : resolve(baseDir, file)));
  }
  return {
    async execute(sql) {
      const reader = await conn.runAndReadAll(sql);
      return reader.getRows() as unknown[][];
    },
  };
}
