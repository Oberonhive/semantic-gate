//! Connectors: run the provider's SQL on a datasource and return rows the way
//! the contract writes them (dates `YYYY-MM-DD`, timestamps RFC 3339,
//! integers as JSON numbers).
//!
//! One module for both kinds because they share the only thing callers see —
//! `execute` — and each is small. Both are read-only: ClickHouse is asked
//! with `readonly=2`, DuckDB is files and views (or a database opened
//! read-only). Errors map to the closed taxonomy; a DBMS message that reaches
//! a caller is the provider's SQL being wrong, never a credential.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use duckdb::types::{TimeUnit, ValueRef};
use duckdb::{AccessMode, Connection};
use semantic_gate_core::ErrorCode;
use semantic_gate_core::protocol::Dialect;
use serde_json::Value;

use crate::calendar;
use crate::config::Datasource;
use crate::failure::Failure;

/// Rows, row-major.
pub type Rows = Vec<Vec<Value>>;

const EXECUTE_TIMEOUT: Duration = Duration::from_secs(60);

/// A datasource the gate can execute against.
pub enum Connector {
    /// In-process DuckDB.
    DuckDb(Arc<Mutex<Connection>>),
    /// ClickHouse over HTTP.
    ClickHouse(ClickHouse),
}

/// A ClickHouse HTTP endpoint with its credentials, which are used for the
/// `Authorization` header only and appear in no message.
pub struct ClickHouse {
    client: reqwest::Client,
    url: String,
    user: String,
    password: Option<String>,
}

impl Connector {
    /// Open the datasource described by `datasource`.
    ///
    /// # Errors
    /// A message naming what could not be opened.
    pub fn open(datasource: &Datasource) -> Result<Self, String> {
        match datasource {
            Datasource::Duckdb { tables, path } => {
                let conn = match path {
                    Some(path) => Connection::open_with_flags(
                        path,
                        duckdb::Config::default()
                            .access_mode(AccessMode::ReadOnly)
                            .map_err(|e| e.to_string())?,
                    ),
                    None => Connection::open_in_memory(),
                }
                .map_err(|e| e.to_string())?;
                for (name, file) in tables {
                    conn.execute_batch(&view(name, file))
                        .map_err(|e| format!("table {name} ({}): {e}", file.display()))?;
                }
                Ok(Self::DuckDb(Arc::new(Mutex::new(conn))))
            }
            Datasource::Clickhouse {
                url,
                user,
                password,
            } => Ok(Self::ClickHouse(ClickHouse {
                client: reqwest::Client::builder()
                    .timeout(EXECUTE_TIMEOUT)
                    .build()
                    .map_err(|e| e.to_string())?,
                url: url.trim_end_matches('/').to_owned(),
                user: user.clone(),
                password: password.as_ref().map(|p| p.resolve()).transpose()?,
            })),
        }
    }

    /// The SQL dialect providers must target.
    pub fn dialect(&self) -> Dialect {
        match self {
            Self::DuckDb(_) => Dialect::Duckdb,
            Self::ClickHouse(_) => Dialect::Clickhouse,
        }
    }

    /// Run one statement. `namespace` and `request_id` tag it in the
    /// warehouse's own query log where the warehouse has one.
    pub async fn execute(
        &self,
        sql: &str,
        namespace: &str,
        request_id: &str,
    ) -> Result<Rows, Failure> {
        match self {
            Self::DuckDb(conn) => {
                let conn = Arc::clone(conn);
                let sql = sql.to_owned();
                let run = tokio::task::spawn_blocking(move || duck_query(&conn, &sql));
                match tokio::time::timeout(EXECUTE_TIMEOUT, run).await {
                    Err(_) => Err(Failure::new(
                        ErrorCode::TimeoutExecute,
                        "the query timed out",
                    )),
                    Ok(Err(e)) => Err(Failure::new(ErrorCode::Internal, e.to_string())),
                    Ok(Ok(result)) => result,
                }
            }
            Self::ClickHouse(ch) => ch.query(sql, namespace, request_id).await,
        }
    }
}

fn view(name: &str, file: &Path) -> String {
    let path = file.to_string_lossy().replace('\'', "''");
    let reader = if file.extension().is_some_and(|e| e == "parquet") {
        "read_parquet"
    } else {
        "read_csv_auto"
    };
    let name = name.replace('"', "\"\"");
    format!("CREATE VIEW \"{name}\" AS SELECT * FROM {reader}('{path}')")
}

fn duck_query(conn: &Mutex<Connection>, sql: &str) -> Result<Rows, Failure> {
    let sql_error = |e: duckdb::Error| Failure::new(ErrorCode::ProviderError, e.to_string());
    let conn = conn
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut statement = conn.prepare(sql).map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let width = row.as_ref().column_count();
        let mut values = Vec::with_capacity(width);
        for i in 0..width {
            values.push(duck_value(row.get_ref(i).map_err(sql_error)?));
        }
        out.push(values);
    }
    Ok(out)
}

fn number(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

fn duck_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Boolean(b) => Value::Bool(b),
        ValueRef::TinyInt(v) => v.into(),
        ValueRef::SmallInt(v) => v.into(),
        ValueRef::Int(v) => v.into(),
        ValueRef::BigInt(v) => v.into(),
        ValueRef::UTinyInt(v) => v.into(),
        ValueRef::USmallInt(v) => v.into(),
        ValueRef::UInt(v) => v.into(),
        ValueRef::UBigInt(v) => v.into(),
        ValueRef::HugeInt(v) => i64::try_from(v).map_or_else(|_| number(v as f64), Value::from),
        ValueRef::Float(v) => number(f64::from(v)),
        ValueRef::Double(v) => number(v),
        ValueRef::Decimal(d) => {
            let text = d.to_string();
            text.parse::<i64>()
                .map(Value::from)
                .or_else(|_| text.parse::<f64>().map(number))
                .unwrap_or(Value::String(text))
        }
        ValueRef::Date32(days) => Value::String(calendar::date(i64::from(days))),
        ValueRef::Timestamp(unit, v) => {
            let (per_second, nanos_per_unit) = match unit {
                TimeUnit::Second => (1, 1_000_000_000),
                TimeUnit::Millisecond => (1_000, 1_000_000),
                TimeUnit::Microsecond => (1_000_000, 1_000),
                TimeUnit::Nanosecond => (1_000_000_000, 1),
            };
            let secs = v.div_euclid(per_second);
            let nanos = (v.rem_euclid(per_second) * nanos_per_unit) as u32;
            Value::String(calendar::timestamp(secs, nanos))
        }
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        other => Value::String(format!("{other:?}")),
    }
}

impl ClickHouse {
    async fn query(&self, sql: &str, namespace: &str, request_id: &str) -> Result<Rows, Failure> {
        let statement = format!("{} FORMAT JSONCompact", sql.trim().trim_end_matches(';'));
        // `readonly=2`, not 1: no write is possible either way, but 1 also
        // forbids changing settings, and plans carry `SETTINGS` clauses
        // (e.g. `join_use_nulls = 1` for outer joins) as well as our own
        // `log_comment` audit tag.
        let mut url = reqwest::Url::parse(&self.url)
            .map_err(|_| Failure::new(ErrorCode::Internal, "the datasource URL is malformed"))?;
        url.query_pairs_mut()
            .append_pair("readonly", "2")
            .append_pair("query_id", request_id)
            .append_pair(
                "log_comment",
                &format!("semantic-gate;ns={namespace};rid={request_id}"),
            );
        let request = self
            .client
            .post(url)
            .basic_auth(&self.user, self.password.as_deref())
            .body(statement);
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                Failure::new(ErrorCode::TimeoutExecute, "the query timed out")
            } else {
                Failure::new(
                    ErrorCode::UpstreamUnavailable,
                    "the datasource is unreachable",
                )
            }
        })?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|_| Failure::new(ErrorCode::UpstreamUnavailable, "the datasource hung up"))?;
        if status.as_u16() == 401
            || status.as_u16() == 403
            || body.contains("AUTHENTICATION_FAILED")
        {
            return Err(Failure::new(
                ErrorCode::UpstreamAuthFailed,
                "the datasource rejected the configured credentials",
            ));
        }
        if !status.is_success() {
            let mut message: String = body.trim().chars().take(500).collect();
            if let Some(password) = self.password.as_deref().filter(|p| !p.is_empty()) {
                message = message.replace(password, "***");
            }
            return Err(Failure::new(ErrorCode::ProviderError, message));
        }
        clickhouse_rows(&body)
    }
}

fn clickhouse_rows(body: &str) -> Result<Rows, Failure> {
    let bad = |what: &str| {
        Failure::new(
            ErrorCode::Internal,
            format!("unreadable ClickHouse reply: {what}"),
        )
    };
    let reply: Value = serde_json::from_str(body).map_err(|e| bad(&e.to_string()))?;
    let types: Vec<String> = reply["meta"]
        .as_array()
        .ok_or_else(|| bad("no meta"))?
        .iter()
        .map(|c| c["type"].as_str().unwrap_or_default().to_owned())
        .collect();
    let data = reply["data"].as_array().ok_or_else(|| bad("no data"))?;
    Ok(data
        .iter()
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .zip(&types)
                        .map(|(cell, ty)| clickhouse_value(cell, ty))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect())
}

/// ClickHouse quotes 64-bit-and-wider integers and decimals as strings and
/// writes DateTime as `YYYY-MM-DD hh:mm:ss`; the contract wants numbers and
/// RFC 3339. DateTime is read as UTC.
fn clickhouse_value(cell: &Value, ty: &str) -> Value {
    let Some(text) = cell.as_str() else {
        return cell.clone();
    };
    let ty = ty
        .trim_start_matches("LowCardinality(")
        .trim_start_matches("Nullable(");
    if ty.starts_with("Int") || ty.starts_with("UInt") {
        text.parse::<i64>()
            .map(Value::from)
            .or_else(|_| text.parse::<u64>().map(Value::from))
            .unwrap_or_else(|_| cell.clone())
    } else if ty.starts_with("Decimal") {
        text.parse::<f64>().map_or_else(|_| cell.clone(), number)
    } else if ty.starts_with("DateTime") {
        Value::String(format!("{}Z", text.replacen(' ', "T", 1)))
    } else {
        cell.clone()
    }
}
