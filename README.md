<div align="center">

# semantic-gate

**A semantic layer between your warehouse and everything that reads it — with charts built in.**

[![License](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)

</div>

semantic-gate publishes a closed, typed vocabulary of metrics, dimensions
and modifiers over your warehouse. AI agents, BI tools, web pages and
scripts query it the same way and get rows back — and, if asked, a
ready-to-render ECharts chart inferred from the semantics.

## Features

- **Semantic queries** — metrics by dimensions, nested filters, parameters,
  order and limit. A query can only name what the namespace publishes, and
  is checked before a row is read. → [Queries](docs/query.md)
- **Modifiers** — `prev_value`, `delta_abs`, `delta_pct`, `topn`, `rank`,
  `share`, `cumulative`, `rolling`, plus a cube's own. Illegal compositions
  are refused up front. → [Modifiers](docs/query.md#modifiers)
- **Six ways to define the semantic layer** — YAML, Datalog, MetricFlow
  (dbt) import, cube.dev import, free-form TypeScript, free-form Python.
  One contract; consumers cannot tell them apart. → [Cubes](docs/cubes.md)
- **A semantic layer in Datalog** — semtrans: the same rules run in the
  browser, under node and behind the gate. → [Cubes](docs/cubes.md#datalog)
- **Charts built in** — cubes declare display hints, queries may add chart
  hints, and inference returns a complete ECharts option with the reason for
  every decision: line, area, bar, pie, scatter, heatmap, map, KPI, table.
  → [Charts](docs/charts.md)
- **Every way in** — REST, SQL over the PostgreSQL wire protocol, a JS
  client, a CLI, and an MCP server for AI agents.
  → [Interfaces](docs/interfaces.md)
- **Runs anywhere** — a native Rust gate in front of the warehouse, node, or
  a static web page with DuckDB-wasm and no server at all.
  → [Hosts](docs/interfaces.md#browser)
- **Warehouses** — ClickHouse and DuckDB; CSV, Parquet and Iceberg over HTTP.
  → [Warehouses](docs/interfaces.md#warehouses)
- **Safe by construction** — read-only connectors, no stored secrets, a
  closed set of error codes, every ClickHouse query attributable to its
  request. → [Architecture](docs/architecture.md)

## Quick start

Needs Rust, Node.js ≥ 22.18 and, for SQL, `psql`.

```bash
npm ci && cargo build

# rows + chart, in process: the shop cube over its CSV files
node packages/cli/src/main.ts chart --cubes examples/shop/yaml \
  --query examples/shop/queries/04-growth-by-region.json

# the gate: REST on :7792, SQL on :6543
PATH=$PWD/node_modules/.bin:$PATH target/debug/semantic-gate serve --config examples/gate.yaml
curl -s localhost:7792/shop-yaml/query -d '{"metrics": ["revenue"], "dimensions": ["region"]}'
psql -h 127.0.0.1 -p 6543 -c "SELECT region, revenue, delta_pct(revenue, along => 'period') FROM shop WHERE period = '2025-12-01'"

# the browser: the same cube in a static page, no server in the loop
examples/web/serve.sh            # open http://127.0.0.1:8000/examples/web/
```

## Example

```json
{"metrics": ["revenue"], "dimensions": ["region"],
 "filters": {"field": "period", "op": "=", "value": "2025-12-01"},
 "modifiers": [{"name": "delta_pct", "params": {"along": "period"}}],
 "viz": {"y": ["delta_pct(revenue)"], "title": "Revenue growth, Dec 2025 vs Nov 2025"}}
```

```json
{"columns": [{"name": "region", "role": "dimension", …},
             {"name": "revenue", "role": "metric", …},
             {"name": "delta_pct(revenue)", "role": "metric", "modifier": "delta_pct", …}],
 "rows": [["EU", 22611.95, 0.1625], ["North America", 23011.37, -0.0431],
          ["APAC", 13229.73, 0.2806], ["LATAM", 5699.53, -0.0976]]}
```

That is [`examples/shop/queries/04-growth-by-region.json`](examples/shop/queries/04-growth-by-region.json).
Ask for `chart` instead of `query`, and the answer also carries the chart: bars
of the growth, green up and red down, a zero line, a percent axis — and the
reason for each of those choices.

## Documentation

| | |
|---|---|
| [Queries](docs/query.md) | the query, the answer, modifiers, metadata, errors |
| [Cubes](docs/cubes.md) | the six ways to define a semantic layer, visualization hints |
| [Charts](docs/charts.md) | how charts are inferred, query hints, rendering |
| [Interfaces](docs/interfaces.md) | the gate, SQL, JS client, CLI, MCP, browser, warehouses |
| [Architecture](docs/architecture.md) | layers, the provider protocol, principles, limits, development |

## Status

Early. Everything above runs end to end on the bundled examples; the
conformance suite is being written. There is no authentication yet — keep
the gate on loopback.

## License

Proprietary, all rights reserved. The source is published for viewing only:
using, copying, modifying or distributing it needs the copyright holder's
written permission. See [LICENSE](LICENSE).
