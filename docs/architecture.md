# Architecture

One contract, many implementations, three hosts. Everything outside the
contract is replaceable.

- [Layers](#layers) · [Repository map](#repository-map) · [Provider protocol](#provider-protocol)
- [Decisions](#decisions) · [A request, per host](#a-request-per-host)
- [Principles](#principles) · [Non-goals](#non-goals) · [Limits](#limits) · [Development](#development)

## Layers

```text
 presentation  @semantic-gate/viz        metadata + query + rows → chart spec → ECharts option (JSON)
                      ▲
 hosts         semantic-gate (Rust)       REST · pgwire · provider host · connectors (DuckDB, ClickHouse)
               @semantic-gate/client      HTTP transport · local transport (provider in process + DuckDB)
               @semantic-gate/cli         meta · query · explain · chart · serve · mcp · import
                      ▲ provider protocol: initialize · metadata · plan · shutdown
 semantics     @semantic-gate/semtrans    Datalog rules + YAML / MetricFlow / cube.dev front-ends
               @semantic-gate/datalog     Soufflé-subset engine, pure TypeScript
               free-form providers        any TypeScript module · any Python script
                      ▲
 contract      @semantic-gate/contract    query · metadata · result · protocol · manifest · errors
```

Dependencies point down, toward the contract. Chart inference knows no
transport, providers know no host, the contract knows nothing.

## Repository map

| Path | |
|---|---|
| [`packages/contract`](../packages/contract) | the contract: query, metadata, result, provider protocol, `cubes.yaml`, errors |
| [`packages/datalog`](../packages/datalog) | the Datalog engine; the same results as Soufflé on the same program |
| [`packages/semtrans`](../packages/semtrans) | the semantic layer in Datalog (`rules/`), the YAML model, importers, SQL rendering |
| [`packages/viz`](../packages/viz) | chart inference |
| [`packages/client`](../packages/client) | one client over REST or a local runtime |
| [`packages/cli`](../packages/cli) | `semantic-gate-js`: the client as a CLI, plus `serve` and `mcp` |
| [`crates/semantic-gate`](../crates/semantic-gate) | the native gate: config, REST, provider host, connectors |
| [`crates/semantic-gate-sql`](../crates/semantic-gate-sql) | semantic SQL and the pgwire server |
| [`crates/semantic-gate-core`](../crates/semantic-gate-core) | the contract in Rust |
| [`python/semantic-gate-provider`](../python/semantic-gate-provider) | the Python provider SDK, standard library only |
| [`examples`](../examples) | the shop cube written six ways, its data and queries, the web page, `gate.yaml` |

## Provider protocol

JSON-RPC 2.0. A provider in its own process (any language) speaks one JSON
message per line over stdio; in node and the browser it is called directly.

| Method | |
|---|---|
| `initialize` | first call: contract version in, contract version and SQL dialects out |
| `metadata` | the namespace's metrics, dimensions, modifiers and hints |
| `plan` | one query → `{sql, columns}`; never executes |
| `shutdown` | the provider exits after answering |

A refusal is a JSON-RPC error with code `-32000` and
`data: {code, message, hint?}` carrying one of the [error codes](query.md#errors).
The types are in [`packages/contract`](../packages/contract/src/index.ts),
the one normative source; the Rust and Python copies follow it.

## Decisions

- **The provider owns the query.** It decides what is expressible and
  returns the SQL with each output column's provenance; hosts execute, never
  reinterpret.
- **The authoring method is invisible.** A host gets a provider from a cube
  directory's `cubes.yaml` — the gate as a process to spawn, node and the
  browser as an object to call.
- **One declarative engine.** YAML, MetricFlow and cube.dev become one model
  that compiles to the same Datalog facts a hand-written Datalog cube states.
  What a model cannot say, it names as a Datalog rules file.
- **The semantic runtime is TypeScript.** Datalog cubes must run in the
  browser, under node and behind the gate, so semtrans runs its own
  Soufflé-subset engine — in process locally, as a stdio provider behind the
  gate. The rules stay valid Soufflé, which is how the engine is checked.
- **Visual intent is part of the contract**, on both sides: cubes declare
  hints once, a query may add its own. Inference decides by declared kinds,
  additivity and modifier outputs, never by names.
- **The gate never draws.** Charts are options a client renders; the gate
  passes `viz` through untouched.

## A request, per host

- **Native gate.** `POST /{ns}/query`, or SQL on the pgwire listener → the
  namespace's provider process plans it → the datasource's connector runs the
  SQL → `{request_id, columns, rows}`.
- **Node.** `chart --cubes DIR` loads the provider in process and runs the SQL
  in DuckDB; with `--gate URL --ns NAME` the same command goes over REST.
- **Browser.** The client's local transport fetches cubes and data from
  static hosting and runs the SQL in DuckDB-wasm — no server in the loop.

## Principles

- **The closed surface is the product.** Determinism, compositions checked
  before execution, a catalog small enough for an agent's context.
- **No secrets, no data permissions, no state to operate.** Secrets are
  references resolved per connection; permissions and audit stay in the
  database, where they already work.
- **The serviceable surface is a binary and a config file.**
- **A contract fixes semantics, not signatures.** An implementation is valid
  if it passes the conformance suite.
- **No telemetry.** None is collected.

## Non-goals

Declared, not deferred: federated queries across datasources in one request;
access control over metrics or rows; a user store; result caching;
dashboards and UI; scheduling and exports; any write to your warehouse.

## Limits

- **No authentication yet**, on REST or pgwire — bind to loopback.
- A cube's own modifiers are class 1 (a condition or a reformat of one
  aggregate); neighbour, whole-result and window modifiers are built in.
- No drill-across between fact tables; `topn` ranks after dimension filters
  only; `rolling` widening is exact for conjunctive filters.
- A free-form TypeScript cube needs a bundling step to run in a browser.
- DuckDB reads CSV decimals as floating point, so sums can show float noise.

## Development

Rust (stable), Node.js ≥ 22.18 (it runs the TypeScript directly), and `uv`
for the Python example.

```bash
npm ci                                   # the JS workspace
cargo build                              # the gate
npx tsc --noEmit -p tsconfig.json        # typecheck every TypeScript package
cargo test --features env-service        # the gate's tests; each spawns its own gate
```
