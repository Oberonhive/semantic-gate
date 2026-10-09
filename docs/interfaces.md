# Hosts and interfaces

The same namespace answers in three hosts: the **native gate** (a Rust
daemon in front of a warehouse), **node** (CLI and MCP), and the **browser**
(a static page, no server). Every interface speaks the same
[query](query.md).

- [Native gate](#native-gate) · [SQL over the PostgreSQL wire protocol](#sql-over-the-postgresql-wire-protocol)
- [JS client](#js-client) · [CLI](#cli) · [MCP](#mcp) · [Browser](#browser)
- [Warehouses](#warehouses)

## Native gate

One YAML file, read-only connectors, one provider process per namespace.

```bash
cargo build
PATH=$PWD/node_modules/.bin:$PATH target/debug/semantic-gate serve --config examples/gate.yaml
```

`node_modules/.bin` on `PATH` gives the gate `semantic-gate-js`, which it
runs as the provider of semtrans and TypeScript cubes.

```yaml
listen: {http: 127.0.0.1:7792}
datasources:
  shop:      {kind: duckdb, tables: {orders: shop/data/orders.csv}}      # or path: file.duckdb (opened read-only)
  warehouse: {kind: clickhouse, url: http://127.0.0.1:8123, user: default, password: env://CH_PASSWORD}
namespaces:
  shop-yaml:
    cubes: shop/yaml                         # a cube directory
    datasource: shop
    limits: {default_limit: 1000, max_limit: 100000}
    cors: {origins: ["http://127.0.0.1:8000"]}
listeners:
  - {kind: pgwire, listen: 127.0.0.1:6543, namespace: shop-yaml}
```

| Endpoint | |
|---|---|
| `GET /{ns}/metadata` | the namespace's vocabulary and hints |
| `POST /{ns}/query` | a query → `{request_id, columns, rows}` |
| `POST /{ns}/explain` | the compiled SQL, its columns and the provider's plan; nothing runs |
| `GET /catalog` | the namespace names |
| `GET /healthz`, `GET /readyz` | liveness; readiness names the namespaces not up yet |

- **Providers** start with the gate and are restarted with backoff if they
  exit. A namespace whose provider fails is not ready; the others keep
  serving. Compiling a query is bounded by a 10 s timeout.
- **Configuration is strict**: an unknown key or a dangling reference stops
  startup, naming it. Relative paths resolve against the config file.
  Secrets are only ever `env://` references.
- **ClickHouse** queries run with `readonly=2`, `query_id` = the request id
  and `log_comment = semantic-gate;ns=…;rid=…`, so each one is attributable
  in the server's own query log.

## SQL over the PostgreSQL wire protocol

BI tools and SQL clients speak *semantic SQL* to a listener bound to one
namespace. It is translated into the same query and runs through the same
pipeline.

```sql
SELECT period, region, revenue, delta_pct(revenue, along => 'period') AS growth
FROM shop                                  -- any single table name: the namespace
WHERE region IN ('EU', 'APAC') AND period >= '2025-01-01' AND params.time_grain = 'quarter'
QUALIFY topn(by => 'revenue', n => 3, rest => 'collapse')
ORDER BY revenue DESC
LIMIT 100
```

- Metrics as bare names, `MEASURE(x)`, or the `SUM(x)`/`AVG(x)`/… that BI
  tools write; `GROUP BY` is implied.
- Modifiers are functions by their declared name; those without a column of
  their own go in `QUALIFY`.
- `WHERE` maps to the filter operators (`LIKE 'x%'` → `starts_with`,
  `'%x%'` → `contains`); `params.<name> = …` sets a parameter.
- Simple and extended protocol; `version()`, `SET`, `SHOW` and
  `information_schema.tables/columns` answer client chatter; anything else
  is an honest `0A000`.
- Refusals carry the error code in the message and a matching SQLSTATE.

## JS client

`@semantic-gate/client` — one API over a gate or a fully local runtime, in
node and in the browser.

```ts
import { createClient, httpTransport, localTransport, loadCubes } from '@semantic-gate/client';
import { duckdbNode, nodeReader } from '@semantic-gate/client/node';     // or /browser: duckdbWasm, fetchReader

const remote = createClient(httpTransport({ gate: 'http://127.0.0.1:7792', namespace: 'shop-yaml' }));

const { provider, manifest, dir } = await loadCubes('examples/shop/yaml', nodeReader);
const local = createClient(localTransport({ provider, engine: await duckdbNode(manifest.tables, dir) }));

const { response, chart } = await local.chart({ metrics: ['revenue'], dimensions: ['period'] });
```

`metadata()`, `query()`, `explain()` and `chart()`; a refusal throws
`GateError` carrying the [error](query.md#errors).

## CLI

`node packages/cli/src/main.ts` (the `semantic-gate-js` binary) prints every
client capability as one JSON document.

| Command | |
|---|---|
| `meta` · `query` · `explain` · `chart` | against a gate (`--gate URL --ns NAME`) or a local cube directory (`--cubes DIR`); the query from `-q '<json>'`, `--query FILE` or stdin |
| `serve DIR` | a cube directory as a stdio provider — what the gate runs for semtrans and TypeScript cubes |
| `mcp` | an MCP server over stdio, remote or local by the same flags |
| `import metricflow FILE` · `import cubedev FILE` | a foreign model as reviewable YAML |
| `lower FILE.yaml` | a YAML cube as the Datalog facts it compiles to |

A refusal prints the error and exits 1.

## MCP

Tools `get_metadata`, `query`, `chart` (rows, ECharts option and reasons)
and `explain`, over stdio — against a gate, or entirely local:

```bash
claude mcp add shop -- node /path/to/semantic-gate/packages/cli/src/main.ts mcp --gate http://127.0.0.1:7792 --ns shop-yaml
claude mcp add shop-local -- node /path/to/semantic-gate/packages/cli/src/main.ts mcp --cubes /path/to/semantic-gate/examples/shop/yaml
```

## Browser

[`examples/web`](../examples/web) is a static page: it loads a cube
directory over HTTP, compiles it with semtrans, runs the SQL in DuckDB-wasm
and draws the inferred chart with its reasons — or switches to a gate over
REST. Cubes, data and rules can all sit on a CDN.

```bash
examples/web/serve.sh        # then open http://127.0.0.1:8000/examples/web/
```

## Warehouses

| | Behind the gate | Node and browser |
|---|---|---|
| **DuckDB** | in process: CSV and Parquet files as views, or a database file opened read-only | CSV, Parquet, Iceberg over HTTP with ranged reads |
| **ClickHouse** | HTTP interface, `readonly=2`, attributable queries | — |

semtrans writes both dialects; a free-form provider declares the ones it
writes. The gate never writes to a warehouse.
