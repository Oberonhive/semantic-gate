/**
 * REST transport (brief §8.2). A token in browser JS is the documented
 * cross-origin risk (⚠9) — same-origin pages use the cookie session and pass
 * no token.
 */
import type { Envelope, Explain, Metadata, Response, SemanticQuery } from '@semantic-gate/contract';
import { GateError, type Transport } from './index.ts';

export interface HttpOptions {
  /** Base URL of the gate, e.g. `https://gate.corp`. */
  gate: string;
  namespace: string;
  /** Bearer token; omitted for a same-origin cookie session. */
  token?: string;
  /** Injected for tests and non-standard runtimes. */
  fetch?: typeof fetch;
}

/** A non-2xx body is an `Envelope`, thrown as `GateError`. */
export function httpTransport(options: HttpOptions): Transport {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.gate.replace(/\/+$/, '')}/${encodeURIComponent(options.namespace)}`;

  async function call<T>(path: string, body?: SemanticQuery): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (body) headers['content-type'] = 'application/json';
    let res: globalThis.Response;
    try {
      res = await doFetch(`${base}/${path}`, { method: body ? 'POST' : 'GET', headers, ...(body && { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new GateError({ code: 'upstream_unavailable', message: `gate unreachable: ${(e as Error).message}`, request_id: '' });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GateError({ code: 'internal', message: `HTTP ${res.status}: ${text.slice(0, 200)}`, request_id: '' });
    }
    if (!res.ok) throw new GateError(json as Envelope);
    return json as T;
  }

  return {
    metadata: () => call<Metadata>('metadata'),
    query: (q) => call<Response>('query', q),
    explain: (q) => call<Explain>('explain', q),
  };
}
