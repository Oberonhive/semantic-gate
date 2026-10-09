//! `semantic-gate-sql` — the SQL wire surface (brief §8.4, §8.5; ⚠7, ⚠8).
//!
//! BI tools and SQL clients reach a namespace over the PostgreSQL wire
//! protocol and speak *semantic SQL*, which this crate translates into a
//! [`SemanticQuery`] and back. After translation a SQL client is an ordinary
//! caller of the gate's pipeline — same vocabulary, same provider `plan`, same
//! error codes — so BI gets exactly the semantics agents get.
//!
//! The crate knows nothing about providers, connectors or configuration: the
//! gate implements [`Backend`] (two calls) and hands [`serve`] a bound
//! listener. [`translate`] is the pure half (SQL text and [`Metadata`] in,
//! [`Statement`] out); [`serve`] is the wire half.
//!
//! # Semantic SQL
//!
//! ```sql
//! SELECT period, region, revenue, delta_pct(revenue, along => 'period') AS growth
//! FROM shop                                   -- any single table name: the namespace
//! WHERE region IN ('EU', 'US') AND period >= '2025-01-01'
//! QUALIFY topn(revenue, n => 5, rest => 'collapse')
//! ORDER BY revenue DESC
//! LIMIT 100
//! ```
//!
//! - a bare name, `MEASURE(name)`, or `SUM|MIN|MAX|AVG|COUNT(name)` of a
//!   metric is that metric — the metric's own definition aggregates, BI's
//!   wrapper is accepted and ignored; dimensions and metrics are told apart by
//!   [`Metadata`], never by the grammar; `*` is every dimension then every
//!   metric;
//! - `name(metric, k => v, …)` in the select list is a modifier call by its
//!   declared name, so cube-declared modifiers reach BI unchanged (§8.4);
//!   `QUALIFY name([metric,] k => v, …)` (joined by `AND`) spells a modifier
//!   with no column of its own — a modifier whose output is `rows`, such as
//!   `topn`, can only be written there. Modifiers apply in textual order, the
//!   select list first (MOD-002). Parameters are literals or `ARRAY[…]`. The
//!   modifier's column is the response column `name(metric)`;
//! - `GROUP BY` is implied by the dimensions and checked, not required: when
//!   present it must list exactly the selected dimensions (by name, ordinal,
//!   or `ALL`);
//! - `WHERE` maps to the closed filter tree: `= <> != < <= > >=`, `IN`,
//!   `NOT IN`, `BETWEEN`, `IS [NOT] NULL`, `[NOT] LIKE` (`'x%'` →
//!   `starts_with`, `'%x%'` → `contains`, no wildcard → `=`; `_` and other
//!   shapes are refused, `ILIKE` too), combined with `AND`/`OR`/`NOT`.
//!   Predicates on a metric filter after aggregation. Literals may carry a
//!   cast or a type prefix (`DATE '2025-01-01'`), which is dropped;
//! - `params.<name> = <literal>` (or `params.<member>.<name>`) as a top-level
//!   `AND` conjunct of `WHERE` sets a query parameter, e.g.
//!   `WHERE params.time_grain = 'week'`;
//! - `ORDER BY` takes output names, select aliases, ordinals, or a modifier
//!   call; `LIMIT n`. The select list projects and renames the response's
//!   columns.
//!
//! Not semantic SQL, refused with `0A000`: joins, subqueries, `WITH`, set
//! operations, `DISTINCT`, `HAVING`, `OFFSET`, window functions, arithmetic or
//! other expressions in the select list, `COUNT(*)`.
//!
//! # Wire protocol
//!
//! Simple and extended query protocol, text result format, text- and
//! binary-format parameters for integers, floats, booleans and text. No TLS
//! (`SSLRequest` is answered `N`; terminate TLS in front) and **no
//! authentication yet**: startup accepts any user and any credentials, the
//! database name is ignored, and the namespace is the one `serve` was given —
//! auth arrives with the gate's tokens (§7). Do not expose the listener
//! beyond loopback until it does.
//!
//! Binary *result* format is refused (`0A000`); clients that ask for it
//! (pgjdbc after `prepareThreshold`) are configured with `binaryTransfer=false`.
//! Result types: `string`→`text`, `integer`→`int8`, `number`→`float8`,
//! `boolean`→`bool`, `date`→`date`, `timestamp`→`timestamptz`.
//!
//! ## Errors
//!
//! A refusal is an `ErrorResponse` whose message is `"<code>: <message>
//! (<hint>)"` (hint omitted when absent) and whose detail carries the
//! `request_id`. SQLSTATE by code (see [`Refusal::sqlstate`]):
//!
//! | code | SQLSTATE |
//! |---|---|
//! | `unknown_metric`, `unknown_dimension` | `42703` undefined_column |
//! | `unknown_modifier` | `42883` undefined_function |
//! | `invalid_params`, `filter_op_not_allowed` | `22023` invalid_parameter_value |
//! | `invalid_composition`, `non_additive_violation` | `42803` grouping_error |
//! | `result_too_large` | `54000` program_limit_exceeded |
//! | `timeout_compile`, `timeout_execute` | `57014` query_canceled |
//! | `ns_not_found` | `3D000` invalid_catalog_name |
//! | SQL syntax error | `42601` |
//! | anything outside semantic SQL or the catalog list below | `0A000` |
//! | every other code | `XX000` |
//!
//! ## Catalog emulation (⚠8)
//!
//! Enough for `psql` and BI connection chatter, and no more; everything else
//! is `0A000` with an honest message rather than a wrong answer:
//!
//! - `SET …`, `RESET …`, `BEGIN`/`START TRANSACTION`/`COMMIT`/`ROLLBACK`,
//!   `DISCARD …`, `DEALLOCATE …` — accepted, ignored (the session has no
//!   state);
//! - `SHOW <name>` for `server_version`, `server_encoding`, `client_encoding`,
//!   `datestyle`, `timezone`, `standard_conforming_strings`,
//!   `integer_datetimes`, `search_path`, `transaction isolation level`;
//! - `SELECT` without `FROM` over literals and `version()`,
//!   `current_schema()`, `current_database()`, `current_user`,
//!   `session_user`, `pg_backend_pid()`, `current_setting('<name>')`;
//! - `information_schema.tables` and `information_schema.columns`: one table,
//!   named after the namespace in schema `public`, whose columns are the
//!   namespace's dimensions then metrics. These accept column lists, `*`,
//!   aliases, `WHERE` over `= <> IN AND OR NOT IS NULL LIKE`, `ORDER BY` a
//!   column, and `LIMIT`.

mod catalog;
mod translate;
mod wire;

use std::future::Future;

use semantic_gate_core::metadata::{Metadata, ValueType};
use semantic_gate_core::query::SemanticQuery;
use semantic_gate_core::response::Response;
use semantic_gate_core::{Envelope, ErrorCode};
use serde_json::Value;

pub use translate::translate;
pub use wire::serve;

/// What the gate provides to the SQL surface.
pub trait Backend: Send + Sync + 'static {
    /// The namespace's published metadata.
    fn metadata(&self, namespace: &str) -> impl Future<Output = Result<Metadata, Envelope>> + Send;

    /// Run one semantic query through the gate's pipeline.
    fn query(
        &self,
        namespace: &str,
        query: SemanticQuery,
    ) -> impl Future<Output = Result<Response, Envelope>> + Send;
}

/// A semantic SQL statement, translated: the query to run and how the
/// response is projected back into the columns the client asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    /// What to hand to [`Backend::query`].
    pub query: SemanticQuery,
    /// The client's columns, in select-list order.
    pub columns: Vec<Projection>,
}

/// One column of the client's result: a response column, possibly renamed.
#[derive(Debug, Clone, PartialEq)]
pub struct Projection {
    /// The [`Response`] column it reads: a member name or `modifier(metric)`.
    pub source: String,
    /// The name the client sees: the `AS` alias, else the source name.
    pub name: String,
    /// What the metadata predicts the column's type to be (modifier outputs
    /// are `number`, ranks `integer`); an executed result carries the
    /// response's own type.
    pub value_type: ValueType,
}

/// A rectangular result in the shape the wire layer encodes.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    /// Name and type per column.
    pub columns: Vec<(String, ValueType)>,
    /// Row-major values.
    pub rows: Vec<Vec<Value>>,
}

impl Statement {
    /// Project a response onto the client's columns.
    pub fn project(&self, response: Response) -> Result<Table, Refusal> {
        let mut pick = Vec::with_capacity(self.columns.len());
        let mut columns = Vec::with_capacity(self.columns.len());
        for p in &self.columns {
            let Some(i) = response.columns.iter().position(|c| c.name == p.source) else {
                return Err(Refusal::Code {
                    code: ErrorCode::Internal,
                    message: format!("the response has no column `{}`", p.source),
                    hint: None,
                    request_id: Some(response.request_id),
                });
            };
            pick.push(i);
            columns.push((p.name.clone(), response.columns[i].value_type));
        }
        let rows = response
            .rows
            .into_iter()
            .map(|mut row| {
                pick.iter()
                    .map(|&i| std::mem::replace(&mut row[i], Value::Null))
                    .collect()
            })
            .collect();
        Ok(Table { columns, rows })
    }
}

/// Why a statement did not produce rows.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// Not parseable SQL.
    Syntax(String),
    /// SQL this surface does not speak (⚠8).
    Unsupported(String),
    /// A closed-taxonomy refusal, from translation or from the gate.
    Code {
        /// The code, as in a JSON query's error.
        code: ErrorCode,
        /// What is wrong.
        message: String,
        /// What to ask instead.
        hint: Option<String>,
        /// Present when the gate assigned one.
        request_id: Option<String>,
    },
}

impl From<Envelope> for Refusal {
    fn from(e: Envelope) -> Self {
        Refusal::Code {
            code: e.code,
            message: e.message,
            hint: e.hint,
            request_id: Some(e.request_id),
        }
    }
}

impl Refusal {
    /// The PostgreSQL SQLSTATE this refusal is reported under (table in the
    /// crate docs).
    pub fn sqlstate(&self) -> &'static str {
        use ErrorCode::*;
        match self {
            Refusal::Syntax(_) => "42601",
            Refusal::Unsupported(_) => "0A000",
            Refusal::Code { code, .. } => match code {
                UnknownMetric | UnknownDimension => "42703",
                UnknownModifier => "42883",
                InvalidParams | FilterOpNotAllowed => "22023",
                InvalidComposition | NonAdditiveViolation => "42803",
                ResultTooLarge => "54000",
                TimeoutCompile | TimeoutExecute => "57014",
                NsNotFound => "3D000",
                _ => "XX000",
            },
        }
    }

    /// The `ErrorResponse` message: `"<code>: <message> (<hint>)"` for a
    /// closed-taxonomy refusal, the plain message otherwise.
    pub fn message(&self) -> String {
        match self {
            Refusal::Syntax(m) | Refusal::Unsupported(m) => m.clone(),
            Refusal::Code {
                code,
                message,
                hint,
                ..
            } => {
                let code = serde_json::to_value(code)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                match hint {
                    Some(h) => format!("{code}: {message} ({h})"),
                    None => format!("{code}: {message}"),
                }
            }
        }
    }

    /// The gate-assigned request id, when there is one.
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Refusal::Code { request_id, .. } => request_id.as_deref(),
            _ => None,
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for Refusal {}
