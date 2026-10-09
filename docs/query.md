# Queries

One JSON document asks every question, in every host: the REST body, the MCP
tool argument, the client call, the CLI input. SQL clients reach the same
shape by [translation](interfaces.md#sql-over-the-postgresql-wire-protocol).

- [The query](#the-query)
- [The answer](#the-answer)
- [Modifiers](#modifiers)
- [Metadata](#metadata)
- [Errors](#errors)

## The query

```json
{
  "metrics": ["revenue", "orders"],
  "dimensions": ["period", "region"],
  "filters": {"op": "and", "items": [
    {"field": "region", "op": "in", "value": ["EU", "North America"]},
    {"field": "period", "op": ">=", "value": "2025-01-01"}]},
  "modifiers": [{"name": "delta_pct", "params": {"along": "period"}},
                {"name": "topn", "params": {"by": "revenue", "n": 3, "rest": "collapse", "dimension": "region"}}],
  "params": {"time_grain": "quarter"},
  "order": [{"field": "revenue", "dir": "desc"}],
  "limit": 100,
  "viz": {"chart": "bar", "y": ["delta_pct(revenue)"], "title": "Growth"}
}
```

| Field | Meaning |
|---|---|
| `metrics`, `dimensions` | Names from the namespace's [metadata](#metadata). Only `metrics` is required. |
| `filters` | A predicate `{field, op, value}` or a group `{op: and\|or\|not, items}`, nested freely. Operators: `= != > >= < <= in not_in between is_null is_not_null contains starts_with`. On a dimension it filters rows; on a metric, the aggregated result. No raw SQL. |
| `modifiers` | Applied in order, after metrics are computed and before `order` and `limit`. See [Modifiers](#modifiers). |
| `params` | Values for parameters a cube declares: `param` sets it on every member that declares it, `member.param` on one. The more specific key wins, then the declared default. |
| `order`, `limit` | Over any output column, modifier outputs included. A result larger than the namespace's default limit is refused (`result_too_large`), never cut silently. |
| `viz` | Hints for [chart inference](charts.md#query-hints). Planning ignores them, so a stored query stays self-contained. |

## The answer

Rows, plus what each column is:

```json
{"request_id": "18dc96c8520c2f35-4b",
 "columns": [{"name": "region", "role": "dimension", "member": "region", "value_type": "string"},
             {"name": "revenue", "role": "metric", "member": "revenue", "value_type": "number"},
             {"name": "delta_pct(revenue)", "role": "metric", "member": "revenue", "modifier": "delta_pct", "value_type": "number"}],
 "rows": [["EU", 22611.95, 0.1625], ["North America", 23011.37, -0.0431], ["APAC", 13229.73, 0.2806], ["LATAM", 5699.53, -0.0976]]}
```

A modifier's column is named `modifier(metric)`. Dates travel as
`YYYY-MM-DD`, timestamps as RFC 3339, and a time column carries the `grain`
it was presented at.

## Modifiers

A closed vocabulary of transformations, each declaring a class. Composition
rules follow the class, never the name, so a cube's own modifier composes
like a built-in one.

| Modifier | Class | Output | Parameters | Applies to |
|---|---|---|---|---|
| `prev_value` | 2 · neighbour period | `level` | `along` (a date dimension, required), `anchor`, `range` (1), `shift` (= `range`) | any metric |
| `delta_abs` | 2 · neighbour period | `difference` | as `prev_value` | any metric |
| `delta_pct` | 2 · neighbour period | `ratio` | as `prev_value`; null when the previous value is empty or zero | any metric |
| `topn` | 3 · whole result | `rows` | `by` (a metric), `n`, `rest`: `drop` or `collapse` into a `__rest__` row, `dimension` | any metric |
| `rank` | 3 · whole result | `rank` | `by`, `dir` (`desc`); ties broken by the dimension values | any metric |
| `share` | 3 · whole result | `share` | `within`: dimensions bounding each total (default: the whole result) | additive |
| `cumulative` | 3 · whole result | `level` | `along` (a date dimension in the query) | additive |
| `rolling` | 4 · window | `level` | `along`, `n` (≥ 2), `agg`: `avg` or `sum` (`sum` needs additive) | any metric |

Class 1 — a condition or a reformat of one aggregate — is where a cube adds
its own modifiers ([example](cubes.md#datalog)). Column-producing modifiers
also take `metrics` (default: all of the query's).

- **Neighbour periods** are fetched by widening the filter on `along`
  behind the scenes; the rows you get back stay inside the filter you asked
  for.
- **A collapsed `__rest__` row** is re-aggregated from its members, deltas
  included — not averaged from theirs.
- **Illegal compositions are refused before any SQL exists**:
  `invalid_params`, `invalid_composition`, `non_additive_violation`.

## Metadata

`GET /{ns}/metadata` — `meta` in the CLI, `get_metadata` in MCP — is the only
source of truth about a namespace. A query can name nothing else.

- **metrics** — name, description, value type, additivity
  (`additive | semi_additive | mergeable | non_reaggregable`), the dimensions
  it can be cut by, parameters, [display hints](cubes.md#visualization-hints);
- **dimensions** — kind (`time | category | number | geo | entity`), value
  type, grains, parameters, display hints;
- **modifiers** — class, parameter schema, the additivities they accept,
  description, origin (`base | cube`), and output
  (`level | difference | ratio | share | rank | rows`).

## Errors

A closed set of codes, the same in every host. REST answers
`{code, message, request_id, hint?}`; the hint lists what *is* declared.

| Code | HTTP |
|---|---|
| `unknown_metric` `unknown_dimension` `unknown_modifier` `invalid_params` `invalid_composition` `non_additive_violation` `filter_op_not_allowed` | 400 |
| `ns_not_found` | 404 |
| `result_too_large` | 413 |
| `upstream_auth_failed` `provider_error` | 502 |
| `upstream_unavailable` | 503 |
| `timeout_compile` `timeout_execute` | 504 |
| `internal` | 500 |

`token_invalid`, `token_revoked` (401) and `rate_limited` (429) are reserved
for authentication, which has not landed yet.
