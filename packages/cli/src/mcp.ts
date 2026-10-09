/**
 * `mcp` — an MCP server over stdio (protocol 2025-06-18), hand-rolled: three
 * methods and four tools do not justify an SDK dependency. Messages are one
 * JSON document per line; tool results are text JSON.
 */
import { createInterface } from 'node:readline';
import { GateError, type Client } from '@semantic-gate/client';
import type { SemanticQuery } from '@semantic-gate/contract';

const PROTOCOL = '2025-06-18';

const FILTER = {
  description: 'A predicate {field, op, value} or a group {op: and|or|not, items: [...]}.',
  type: 'object',
};

const QUERY_SCHEMA = {
  type: 'object',
  description: 'A semantic query over the namespace vocabulary returned by get_metadata.',
  properties: {
    metrics: { type: 'array', items: { type: 'string' }, minItems: 1 },
    dimensions: { type: 'array', items: { type: 'string' } },
    filters: FILTER,
    modifiers: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, params: { type: 'object' } }, required: ['name'] },
    },
    params: { type: 'object', description: 'Values for declared member parameters, e.g. {"time_grain": "month"}.' },
    order: {
      type: 'array',
      items: { type: 'object', properties: { field: { type: 'string' }, dir: { enum: ['asc', 'desc'] } }, required: ['field', 'dir'] },
    },
    limit: { type: 'integer', minimum: 1 },
    viz: {
      type: 'object',
      description: 'Chart hints: chart, x, series, y, stack, orientation, title, echarts.',
      properties: {
        chart: { enum: ['line', 'area', 'bar', 'pie', 'scatter', 'heatmap', 'map', 'kpi', 'table'] },
        x: { type: 'string' },
        series: { type: 'string' },
        y: { type: 'array', items: { type: 'string' } },
        stack: { enum: ['none', 'stacked', 'percent'] },
        orientation: { enum: ['vertical', 'horizontal'] },
        title: { type: 'string' },
        echarts: { type: 'object' },
      },
    },
  },
  required: ['metrics'],
};

const queryInput = { type: 'object', properties: { query: QUERY_SCHEMA }, required: ['query'] };

const TOOLS = [
  { name: 'get_metadata', description: 'The namespace vocabulary: metrics, dimensions, modifiers and their display hints. Read it before querying.', inputSchema: { type: 'object', properties: {} } },
  { name: 'query', description: 'Run a semantic query; returns {request_id, columns, rows}.', inputSchema: queryInput },
  { name: 'chart', description: 'Run a semantic query and return {response, chart: {spec, option}}: rows plus the inferred ECharts option and the reasons for each decision.', inputSchema: queryInput },
  { name: 'explain', description: 'Compile a semantic query without running it; returns the SQL and the output columns.', inputSchema: queryInput },
];

interface Msg {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: { query?: SemanticQuery } };
}

const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (doc: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(doc) }], ...(isError && { isError }) });

async function callTool(client: Client, name: string | undefined, query: SemanticQuery | undefined) {
  try {
    if (name === 'get_metadata') return text(await client.metadata());
    if (!query) return text({ code: 'invalid_params', message: 'missing `query`', request_id: '' }, true);
    if (name === 'query') return text(await client.query(query));
    if (name === 'explain') return text(await client.explain(query));
    if (name === 'chart') return text(await client.chart(query));
    return text({ code: 'invalid_params', message: `unknown tool ${name}`, request_id: '' }, true);
  } catch (e) {
    return text(e instanceof GateError ? e.envelope : { code: 'internal', message: (e as Error).message, request_id: '' }, true);
  }
}

export async function mcp(client: Client): Promise<number> {
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg: Msg;
      try {
        msg = JSON.parse(line) as Msg;
      } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      // A message without an id is a notification: never answered.
      if (msg.id === undefined) return;
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'semantic-gate-js', version: '0.0.0' } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: TOOLS });
        case 'tools/call': return reply(await callTool(client, msg.params?.name, msg.params?.arguments?.query));
        default: return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
    });
  });
  await new Promise<void>((done) => lines.on('close', () => void queue.then(() => done())));
  return 0;
}
