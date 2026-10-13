/**
 * Local transport — a gate inside the page or the node process. The provider
 * is called in process; its SQL runs in whatever `SqlEngine` the host brings
 * (duckdb-wasm in a browser, `@duckdb/node-api` under node). Only DuckDB-dialect
 * SQL can run here (§13).
 */
import {
  CONTRACT_VERSION,
  Refusal,
  type Column,
  type Dialect,
  type Envelope,
  type ErrorCode,
  type Explain,
  type Json,
  type Plan,
  type Provider,
  type Response,
  type SemanticQuery,
} from '@semantic-gate/contract';
import { GateError, type Transport } from './index.ts';

/** The one thing the host must supply: run SQL, return rows. Values may be raw driver values. */
export interface SqlEngine {
  execute(sql: string): Promise<unknown[][]>;
}

export interface LocalOptions {
  provider: Provider;
  engine: SqlEngine;
  dialect?: Dialect;
  /** IANA zone date truncation happens in. */
  timezone?: string;
  limits?: { defaultLimit?: number };
}

const DEFAULT_LIMIT = 1000;

export function localTransport(options: LocalOptions): Transport {
  const { provider, engine, dialect = 'duckdb', timezone = 'UTC' } = options;
  const defaultLimit = options.limits?.defaultLimit ?? DEFAULT_LIMIT;
  let ready: Promise<unknown> | undefined;
  let metadata: ReturnType<Provider['metadata']> | undefined;

  const refuse = (e: unknown, request_id: string): never => {
    if (e instanceof GateError) throw e;
    if (e instanceof Refusal) {
      throw new GateError({ code: e.code, message: e.message, request_id, ...(e.hint && { hint: e.hint }) });
    }
    const code = (e as { code?: unknown } | null)?.code;
    const err = e as Error;
    const envelope: Envelope =
      typeof code === 'string' && code in REFUSAL_CODES
        ? { code: code as ErrorCode, message: err.message, request_id }
        : { code: 'internal', message: err?.message ?? String(e), request_id };
    throw new GateError(envelope);
  };

  const plan = async (query: SemanticQuery, request_id: string, probe: boolean): Promise<{ plan: Plan; limited: boolean }> => {
    ready ??= Promise.resolve(provider.initialize({ contract_version: CONTRACT_VERSION }));
    await ready;
    // Without an explicit limit the default applies; a query asks for one row more so overflow is detectable.
    const limited = query.limit === undefined;
    const effective: SemanticQuery = limited ? { ...query, limit: defaultLimit + (probe ? 1 : 0) } : query;
    try {
      const p = await provider.plan({
        query: effective,
        dialect,
        context: { evaluation_time: new Date().toISOString(), timezone },
      });
      return { plan: p, limited };
    } catch (e) {
      return refuse(e, request_id);
    }
  };

  return {
    async metadata() {
      metadata ??= Promise.resolve(provider.metadata());
      ready ??= Promise.resolve(provider.initialize({ contract_version: CONTRACT_VERSION }));
      await ready;
      return metadata;
    },
    async query(query) {
      const request_id = crypto.randomUUID();
      const { plan: p, limited } = await plan(query, request_id, true);
      let raw: unknown[][];
      try {
        raw = await engine.execute(p.sql);
      } catch (e) {
        throw new GateError({ code: 'upstream_unavailable', message: (e as Error).message, request_id });
      }
      if (limited && raw.length > defaultLimit) {
        throw new GateError({
          code: 'result_too_large',
          message: `result exceeds the default limit of ${defaultLimit} rows`,
          request_id,
          hint: 'add a filter, a topn modifier, or an explicit limit',
        });
      }
      return { request_id, columns: p.columns, rows: raw.map((r) => r.map((v, i) => normalise(v, p.columns[i]))) } satisfies Response;
    },
    async explain(query) {
      const request_id = crypto.randomUUID();
      const { plan: p } = await plan(query, request_id, false);
      return { request_id, sql: p.sql, columns: p.columns, ...(p.plan !== undefined && { plan: p.plan }) } satisfies Explain;
    },
  };
}

const REFUSAL_CODES: Record<ErrorCode, true> = {
  unknown_metric: true, unknown_dimension: true, unknown_modifier: true, invalid_params: true,
  invalid_composition: true, non_additive_violation: true, filter_op_not_allowed: true, result_too_large: true,
  timeout_compile: true, timeout_execute: true, upstream_auth_failed: true, upstream_unavailable: true,
  ns_not_found: true, token_invalid: true, token_revoked: true, rate_limited: true, provider_error: true, internal: true,
};

/** Driver values → the wire shape: dates `YYYY-MM-DD`, timestamps RFC 3339, bigint/decimal → number. */
export function normalise(v: unknown, col: Column | undefined): Json {
  if (v === null || v === undefined) return null;
  const type = col?.value_type;
  if (type === 'date' || type === 'timestamp') {
    const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v) : undefined;
    const iso = d ? d.toISOString() : String(v).replace(' ', 'T');
    if (type === 'date') return iso.slice(0, 10);
    return /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  }
  if (typeof v === 'bigint') return Number(v);
  if ((type === 'integer' || type === 'number') && typeof v === 'string') return Number(v);
  if (typeof v === 'object') return String(v);
  return v as Json;
}
