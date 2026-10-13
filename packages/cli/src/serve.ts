/**
 * `serve DIR` — the stdio provider the native gate spawns: the cube directory's
 * provider behind JSON-RPC 2.0, one message per line. Stdout carries protocol
 * and nothing else; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { loadCubes } from '@semantic-gate/client';
import { nodeReader } from '@semantic-gate/client/node';
import { Refusal, REFUSAL_RPC_CODE, type PlanParams, type Provider, type InitializeParams } from '@semantic-gate/contract';

interface Call {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);

export async function serve(dir: string): Promise<number> {
  let provider: Provider;
  try {
    ({ provider } = await loadCubes(dir, nodeReader));
  } catch (e) {
    process.stderr.write(`semantic-gate-js serve: ${(e as Error).message}\n`);
    return 1;
  }

  const handle = async (call: Call): Promise<unknown> => {
    switch (call.method) {
      case 'initialize': return provider.initialize(call.params as InitializeParams);
      case 'metadata': return provider.metadata();
      case 'plan': return provider.plan(call.params as PlanParams);
      case 'shutdown': return null;
      default: throw Object.assign(new Error(`method not found: ${call.method}`), { rpc: -32601 });
    }
  };

  // One message at a time: replies keep the order of requests.
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let call: Call;
      try {
        call = JSON.parse(line) as Call;
      } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      const id = call.id ?? null;
      try {
        const result = await handle(call);
        send({ jsonrpc: '2.0', id, result });
        if (call.method === 'shutdown') {
          lines.close();
          process.stdin.destroy();
        }
      } catch (e) {
        if (e instanceof Refusal) {
          send({ jsonrpc: '2.0', id, error: { code: REFUSAL_RPC_CODE, message: e.message, data: { code: e.code, message: e.message, ...(e.hint && { hint: e.hint }) } } });
        } else {
          const rpc = (e as { rpc?: number }).rpc;
          process.stderr.write(`${(e as Error).stack ?? e}\n`);
          send({ jsonrpc: '2.0', id, error: { code: rpc ?? -32603, message: (e as Error).message } });
        }
      }
    });
  });
  await new Promise<void>((done) => lines.on('close', () => void queue.then(() => done())));
  return 0;
}
