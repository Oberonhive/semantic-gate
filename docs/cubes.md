# Cubes

A semantic layer is a directory of cubes. It can be written six ways; each
yields the same contract, and no consumer can tell them apart.

- [The cube directory](#the-cube-directory)
- [YAML](#yaml) · [Datalog](#datalog) · [MetricFlow and cube.dev](#metricflow-and-cubedev) · [Free-form TypeScript and Python](#free-form-typescript-and-python)
- [Visualization hints](#visualization-hints)

The same shop cube is written all six ways in
[`examples/shop`](../examples/shop); the four declarative versions return
identical rows for each of its twelve example queries.

## The cube directory

A `cubes.yaml` at its root says how the cubes are written:

```yaml
contract: "0.1"
semtrans: [shop.yaml, returns.dl, {metricflow: semantic_manifest.json}, {cubedev: model.yml}]
# or  module: cube.ts                          free-form TypeScript
# or  entrypoint: [python3, shop_cube.py]      free-form Python (native gate only)
tables:                                        # local hosts: where each table's data is
  orders: ../data/orders.csv                   # .csv, .parquet, or an Iceberg table / metadata.json URL
```

| Method | `cubes.yaml` | Runs in | Example |
|---|---|---|---|
| YAML | `semtrans: [shop.yaml]` | every host | [`shop/yaml`](../examples/shop/yaml) |
| Datalog | `semtrans: [shop.dl]` | every host | [`shop/datalog`](../examples/shop/datalog) |
| MetricFlow (dbt) | `semtrans: [{metricflow: semantic_manifest.json}]` | every host | [`shop/metricflow`](../examples/shop/metricflow) |
| cube.dev | `semtrans: [{cubedev: model.yml}]` | every host | [`shop/cubedev`](../examples/shop/cubedev) |
| free-form TypeScript | `module: cube.ts` | every host | [`shop/typescript`](../examples/shop/typescript) |
| free-form Python | `entrypoint: [python3, shop_cube.py]` | native gate | [`shop/python`](../examples/shop/python) |

The first four share one engine, **semtrans**: the semantic layer written in
Datalog ([`packages/semtrans/rules`](../packages/semtrans/rules)) and run by a
Soufflé-compatible engine in TypeScript, so the same rules run in the
browser, under node, and behind the gate. Sources listed together compile
into one program, so a YAML cube and a Datalog file can extend each other.

## YAML

A metric is an aggregate `agg` (`sum count count_distinct min max avg`, with
an optional row `filter`), raw `sql`, `derived` from other metrics by
`{name}`, or `two_stage` (an aggregate of a per-entity aggregate). A `{name}`
hole anywhere else is a parameter.

```yaml
cube: shop
table: orders
alias: o
joins:
  customers: {table: customers, alias: c, on: o.customer_id = c.customer_id}
metrics:
  revenue: {agg: sum, expr: o.revenue, display: {unit: USD, format: currency, good_when: up}}
  orders:  {agg: count, value_type: integer}
  aov:     {derived: "{revenue} / nullif({orders}, 0)", display: {unit: USD, format: currency}}
dimensions:
  period:
    sql: "date_trunc('{time_grain}', o.order_date)"
    kind: time
    grains: [day, week, month, quarter, year]
    params: {time_grain: {type: string, enum: [day, week, month, quarter, year], default: month}}
  country: {sql: o.country, kind: geo}
  segment: {sql: c.segment, joins: [customers]}
```

## Datalog

The same cube as facts — and a modifier of the cube's own, as rules hooked
into the plan:

```prolog
c_cube("shop", "orders", "o").
c_metric("shop", "revenue").
c_m_agg("shop", "revenue", "sum", "o.revenue").
c_display("shop", "m:revenue", "{\"unit\":\"USD\",\"format\":\"currency\"}").
// weekend(m): the metric over weekend orders only
c_modifier("shop", "weekend", 1, "level", "The metric over weekend orders only.").
mod_cond(J, "extract(isodow from o.order_date) >= 6") :- mcall(J, "weekend"), dia("duckdb").
mod_cond(J, "toDayOfWeek(o.order_date) >= 6")        :- mcall(J, "weekend"), dia("clickhouse").
```

A YAML cube can declare the same modifier and point its `rules:` at a `.dl`
file.

## MetricFlow and cube.dev

dbt's `semantic_manifest.json` and cube.dev's YAML data model are imported
when the cubes load. To review the result first, print it as YAML:

```bash
node packages/cli/src/main.ts import metricflow semantic_manifest.json
```

Hints the formats have no field for travel in their `meta` (`config.meta` in
dbt, `meta` in cube.dev). An unsupported construct — a cumulative MetricFlow
metric, cube.dev `segments` — is refused by name, never approximated.

## Free-form TypeScript and Python

Implement `initialize`, `metadata` and `plan`, and build the SQL however you
like. Declare only what you implement: anything else is refused as
`unknown_*`.

```ts
import { defineProvider, Refusal, CONTRACT_VERSION } from '@semantic-gate/contract';
export default defineProvider({
  initialize: () => ({ contract_version: CONTRACT_VERSION, dialects: ['duckdb'] }),
  metadata: () => ({ /* metrics, dimensions, modifiers, hints */ }),
  plan: ({ query, dialect }) => ({ sql: '…', columns: [/* provenance */] }),  // or throw new Refusal(code, message, hint)
});
```

```python
from semantic_gate_provider import serve, Refusal   # standard library only
serve(Shop())                                       # JSON-RPC over stdio
```

The protocol both speak is in [Architecture](architecture.md#provider-protocol).

## Visualization hints

Declared once in the cube, published in metadata, read by every consumer and
by [chart inference](charts.md):

| On | Hints |
|---|---|
| metric | `label`, `unit` (a suffix or a currency code), `format` (`number \| percent \| currency \| duration`), `decimals`, `good_when` (`up \| down`), `color` |
| dimension | `kind` (`time \| category \| number \| geo \| entity`), `grains`, `label`, `order` (members' ordinal order), `colors` (per member) |
| modifier | `output` (`level \| difference \| ratio \| share \| rank \| rows`) — what it does to its metric's values |
