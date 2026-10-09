/**
 * @semantic-gate/client — the JS way into a semantic layer, for web pages and
 * node scripts alike.
 *
 * One `Client` over interchangeable transports:
 * - `httpTransport` — a gate's REST surface (`/{ns}/metadata|query|explain`);
 * - `localTransport` — no server: a `Provider` in process plus a `SqlEngine`
 *   (DuckDB: `@semantic-gate/client/node` or `/browser`).
 *
 * `chart()` returns rows and the complete ECharts option inferred from them.
 * This entry point imports nothing node-specific.
 */
import type { Envelope, Explain, Metadata, Response, SemanticQuery } from '@semantic-gate/contract';
import { inferChart, type Chart, type Theme } from '@semantic-gate/viz';

export { httpTransport, type HttpOptions } from './http.ts';
export { localTransport, type LocalOptions, type SqlEngine } from './local.ts';
export { loadCubes, tableSql, type LoadedCubes, type Reader, type TableDefs } from './cubes.ts';

/** What a transport must answer. Failures are thrown as `GateError`. */
export interface Transport {
  metadata(): Promise<Metadata>;
  query(query: SemanticQuery): Promise<Response>;
  explain(query: SemanticQuery): Promise<Explain>;
}

export interface Client extends Transport {
  /** Rows plus the chart inferred from them; hints travel in `query.viz`. */
  chart(query: SemanticQuery, theme?: Theme): Promise<ChartedResponse>;
}

export interface ChartedResponse {
  response: Response;
  chart: Chart;
}

/** A closed-taxonomy refusal (§3.4), carried unchanged from the gate or the local pipeline. */
export class GateError extends Error {
  readonly envelope: Envelope;
  constructor(envelope: Envelope) {
    super(`${envelope.code}: ${envelope.message}`);
    this.envelope = envelope;
  }
}

export function createClient(transport: Transport): Client {
  return {
    metadata: () => transport.metadata(),
    query: (query) => transport.query(query),
    explain: (query) => transport.explain(query),
    async chart(query, theme) {
      // Metadata is read per call rather than memoised: a cube sync changes it
      // under a long-lived client, and a stale unit or kind draws a wrong chart.
      const [metadata, response] = await Promise.all([transport.metadata(), transport.query(query)]);
      return { response, chart: inferChart({ metadata, query, response }, theme) };
    },
  };
}
