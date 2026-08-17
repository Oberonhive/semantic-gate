<div align="center">

# semantic-gate

**A thin serving layer between your warehouse and everything that reads it.**

Semantic queries over a closed, parameterised modifier vocabulary — so a catalog
of *N* metrics and *M* modifiers replaces *N×M* hand-written definitions, and
every composition is decidable before a single row is read.

[![CI](https://github.com/Oberonhive/semantic-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/Oberonhive/semantic-gate/actions/workflows/ci.yml)
[![Docs](https://github.com/Oberonhive/semantic-gate/actions/workflows/docs.yml/badge.svg)](https://oberonhive.github.io/semantic-gate/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Documentation](https://oberonhive.github.io/semantic-gate/) ·
[Product brief](prd.md) ·
[Specification](https://oberonhive.github.io/semantic-gate/spec/overview.html) ·
[What is proven](https://oberonhive.github.io/semantic-gate/spec/coverage.html)

</div>

---

## Status

**Pre-implementation.** The specification is being derived from the brief, one
capability at a time; code follows a scenario, never the reverse. The
[coverage catalog](docs/spec/coverage.md) is the honest answer to "does it
work" — it is empty today, and it will never claim more than was actually run.

## What it is

Agents over MCP, custom reports, BI tools, and scripts all need governed
access to your warehouse. Today that means either raw SQL — ungoverned,
unauditable, a different query shape from every consumer — or a bespoke
integration per consumer, whose maintenance grows with every metric and every
client. semantic-gate is the alternative: one **gate**, one semantic surface,
closed to anything outside a parameterised modifier vocabulary, that every
consumer — agent, dashboard, script — queries the same way.

Closed here means enumerable and typed, not simplistic: a namespace declares
its metrics, dimensions, and modifiers once and publishes them as metadata,
and every request is checked against that catalog before a row is read. That
buys determinism — the same request returns the same answer — and verifiable
composition — an illegal combination of modifiers is a rejected request, not
an undefined one. It also buys something specific to agents: a catalog of *N*
metrics and *M* modifiers is small enough to hold in context whole, instead of
guessing at a bespoke API's shape or writing raw SQL against a schema it only
half understands. The warehouse remains the query engine; the gate
contributes the contract.

```json
{
  "metrics": ["revenue"],
  "dimensions": ["region", "month"],
  "filters": {"op": "and", "items": [{"field": "region", "op": "in", "value": ["EU", "US"]}]},
  "modifiers": [{"name": "delta_pct", "params": {"along": "month"}},
                {"name": "topn", "params": {"by": "revenue", "n": 5, "universe": "post_filter"}}]
}
```

That request surface is **closed**. There is no raw SQL in it, no escape hatch,
and no undefined behaviour: every modifier declares the universe it operates
over, every illegal composition is an error code before SQL is generated, and
every rule is pinned by a row in the conformance suite. Flexibility lives on the
other side of the wall — a metric definition may contain any native SQL your
warehouse understands.

## Principles

- **The closed surface is the product.** Determinism, verifiable composition, a
  compact catalog an agent can hold in context.
- **No secrets, no data RBAC, no state you must operate.** The gate resolves
  secret *references* per connection; permissions and audit stay in the
  database, where they are already correct.
- **Serviceable surface is binary + config + tokens.** A design that demands
  more of a DevOps reader is rejected at design time.
- **A contract fixes semantics, not signatures.** An implementation is valid if
  and only if it passes the conformance suite.
- **No telemetry.** None is collected. The only mechanism ever permitted is an
  opt-in version ping, off by default.

## Non-goals

Declared, not deferred: federated queries across datasources in one request; a
built-in RBAC over metrics or rows beyond per-token namespace visibility; a user
store or LDAP; result caching; dashboards and UI; scheduling and exports;
telemetry; any write to your warehouse other than an opt-in audit sink.

They are what keeps this service auditable. See [brief §13](prd.md#13-non-goals-объявляются-в-readme).

## Learn more

How a request resolves, the provider model, and the dev loop are in
[docs/architecture.md](docs/architecture.md); contribution workflow is in
[CLAUDE.md](CLAUDE.md).

## License

[Apache-2.0](LICENSE).
