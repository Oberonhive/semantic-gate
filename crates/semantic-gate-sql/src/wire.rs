//! The PostgreSQL wire listener: pgwire handlers over [`Backend`].

use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{Sink, StreamExt, stream};
use pgwire::api::auth::noop::NoopStartupHandler;
use pgwire::api::portal::{Format, Portal};
use pgwire::api::query::{ExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{
    DataRowEncoder, DescribePortalResponse, DescribeStatementResponse, FieldFormat, FieldInfo,
    QueryResponse, Response as PgResponse, Tag,
};
use pgwire::api::stmt::{NoopQueryParser, StoredStatement};
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::PgWireBackendMessage;
use pgwire::tokio::process_socket;
use semantic_gate_core::metadata::ValueType;
use semantic_gate_core::query::SemanticQuery;
use serde_json::Value;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::catalog::{self, Outcome};
use crate::translate::{self, parse};
use crate::{Backend, Refusal, Table};

/// Serve semantic SQL for `namespace` on `listener` until the listener fails.
///
/// Every connection is the same session: no credentials are checked (see the
/// crate docs) and the client's database name is ignored.
pub async fn serve<B: Backend>(
    listener: tokio::net::TcpListener,
    namespace: String,
    backend: Arc<B>,
) -> std::io::Result<()> {
    let handlers = Arc::new(Handler {
        namespace,
        backend,
        parser: Arc::new(NoopQueryParser::new()),
    });
    loop {
        let (socket, _) = listener.accept().await?;
        let handlers = handlers.clone();
        tokio::spawn(async move {
            // A broken client connection is the client's, not the gate's.
            let _ = process_socket(socket, None, handlers).await;
        });
    }
}

struct Handler<B> {
    namespace: String,
    backend: Arc<B>,
    parser: Arc<NoopQueryParser>,
}

impl<B: Backend> PgWireServerHandlers for Handler<B> {
    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        Arc::new(self.clone_handle())
    }
    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> {
        Arc::new(self.clone_handle())
    }
    fn startup_handler(&self) -> Arc<impl pgwire::api::auth::StartupHandler> {
        Arc::new(self.clone_handle())
    }
}

impl<B> Handler<B> {
    fn clone_handle(&self) -> Handler<B> {
        Handler {
            namespace: self.namespace.clone(),
            backend: self.backend.clone(),
            parser: self.parser.clone(),
        }
    }
}

#[async_trait]
impl<B: Backend> NoopStartupHandler for Handler<B> {}

/// What one statement produced.
enum Out {
    Empty,
    Command(&'static str),
    Table(Table),
    Error(Refusal),
}

fn pg_type(t: ValueType) -> Type {
    match t {
        ValueType::String => Type::TEXT,
        ValueType::Integer => Type::INT8,
        ValueType::Number => Type::FLOAT8,
        ValueType::Boolean => Type::BOOL,
        ValueType::Date => Type::DATE,
        ValueType::Timestamp => Type::TIMESTAMPTZ,
    }
}

fn fields(t: &Table) -> Arc<Vec<FieldInfo>> {
    Arc::new(
        t.columns
            .iter()
            .map(|(n, ty)| FieldInfo::new(n.clone(), None, None, pg_type(*ty), FieldFormat::Text))
            .collect(),
    )
}

fn error(r: &Refusal) -> PgResponse {
    let mut e = ErrorInfo::new("ERROR".into(), r.sqlstate().into(), r.message());
    e.detail = r.request_id().map(|id| format!("request_id: {id}"));
    PgResponse::Error(Box::new(e))
}

fn user_error(r: &Refusal) -> PgWireError {
    match error(r) {
        PgResponse::Error(e) => PgWireError::UserError(e),
        _ => unreachable!("error() builds an error"),
    }
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "t" } else { "f" }.into()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn respond(out: Out) -> PgWireResult<PgResponse> {
    Ok(match out {
        Out::Empty => PgResponse::EmptyQuery,
        Out::Error(r) => error(&r),
        Out::Command("BEGIN") => PgResponse::TransactionStart(Tag::new("BEGIN")),
        Out::Command(t @ ("COMMIT" | "ROLLBACK")) => PgResponse::TransactionEnd(Tag::new(t)),
        Out::Command(t) => PgResponse::Execution(Tag::new(t)),
        Out::Table(t) => {
            let schema = fields(&t);
            let rows = t
                .rows
                .iter()
                .map(|row| {
                    let mut enc = DataRowEncoder::new(schema.clone());
                    for v in row {
                        enc.encode_field_with_type_and_format(
                            &text(v),
                            &Type::TEXT,
                            FieldFormat::Text,
                            &Default::default(),
                        )?;
                    }
                    enc.finish()
                })
                .collect::<Vec<_>>();
            PgResponse::Query(QueryResponse::new(schema, stream::iter(rows).boxed()))
        }
    })
}

impl<B: Backend> Handler<B> {
    /// Run (or, when `dry`, only shape) every statement in `sql`. Stops at
    /// the first refusal.
    async fn exec(&self, sql: &str, params: &[Value], dry: bool) -> Vec<Out> {
        let stmts = match parse(sql) {
            Ok(s) => s,
            Err(r) => return vec![Out::Error(r)],
        };
        if stmts.is_empty() {
            return vec![Out::Empty];
        }
        let mut outs = Vec::new();
        for stmt in &stmts {
            let out = self.exec_one(stmt, params, dry).await;
            let stop = matches!(out, Out::Error(_));
            outs.push(out);
            if stop {
                break;
            }
        }
        outs
    }

    async fn exec_one(&self, stmt: &sqlparser::ast::Statement, params: &[Value], dry: bool) -> Out {
        let md = if matches!(stmt, sqlparser::ast::Statement::Query(_)) {
            match self.backend.metadata(&self.namespace).await {
                Ok(md) => Some(md),
                Err(e) => return Out::Error(e.into()),
            }
        } else {
            None
        };
        let empty = semantic_gate_core::metadata::Metadata {
            contract_version: String::new(),
            cubes_sha: String::new(),
            metrics: vec![],
            dimensions: vec![],
            modifiers: vec![],
        };
        let md_ref = md.as_ref().unwrap_or(&empty);
        match catalog::handle(stmt, md_ref, &self.namespace, params) {
            Some(Ok(Outcome::Command(t))) => Out::Command(t),
            Some(Ok(Outcome::Table(t))) => Out::Table(t),
            Some(Err(r)) => Out::Error(r),
            None => {
                let sqlparser::ast::Statement::Query(q) = stmt else {
                    unreachable!("catalog claims every non-query");
                };
                match self.semantic(q, md_ref, params, dry).await {
                    Ok(t) => Out::Table(t),
                    Err(r) => Out::Error(r),
                }
            }
        }
    }

    async fn semantic(
        &self,
        q: &sqlparser::ast::Query,
        md: &semantic_gate_core::metadata::Metadata,
        params: &[Value],
        dry: bool,
    ) -> Result<Table, Refusal> {
        let st = translate::query(q, md, params)?;
        if dry {
            return Ok(Table {
                columns: st
                    .columns
                    .iter()
                    .map(|p| (p.name.clone(), p.value_type))
                    .collect(),
                rows: vec![],
            });
        }
        let query: SemanticQuery = st.query.clone();
        let response = self.backend.query(&self.namespace, query).await?;
        st.project(response)
    }
}

#[async_trait]
impl<B: Backend> SimpleQueryHandler for Handler<B> {
    async fn do_query<C>(&self, _client: &mut C, query: &str) -> PgWireResult<Vec<PgResponse>>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        self.exec(query, &[], false)
            .await
            .into_iter()
            .map(respond)
            .collect()
    }
}

fn binary_requested(f: &Format) -> bool {
    match f {
        Format::UnifiedText => false,
        Format::UnifiedBinary => true,
        Format::Individual(v) => v.contains(&1),
    }
}

fn no_binary() -> PgWireError {
    user_error(&Refusal::Unsupported(
        "binary result format is not supported; ask for text (pgjdbc: binaryTransfer=false)".into(),
    ))
}

/// The highest `$n` in `sql`.
fn placeholder_count(sql: &str) -> usize {
    let tokens = Tokenizer::new(&sqlparser::dialect::PostgreSqlDialect {}, sql)
        .tokenize()
        .unwrap_or_default();
    tokens
        .iter()
        .filter_map(|t| match t {
            Token::Placeholder(p) => p.strip_prefix('$')?.parse::<usize>().ok(),
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

/// Bound parameter → JSON; text-format values are typed by the declared type,
/// or by their look when the client left it open.
fn bind_value(raw: Option<&[u8]>, ty: Option<&Type>, fmt: FieldFormat) -> Result<Value, Refusal> {
    let Some(b) = raw else { return Ok(Value::Null) };
    let bad = |what: &str| Refusal::Unsupported(format!("cannot read a bound {what} parameter"));
    if fmt == FieldFormat::Binary {
        return match ty {
            Some(&Type::INT2) => {
                Ok(i16::from_be_bytes(b.try_into().map_err(|_| bad("int2"))?).into())
            }
            Some(&Type::INT4) => {
                Ok(i32::from_be_bytes(b.try_into().map_err(|_| bad("int4"))?).into())
            }
            Some(&Type::INT8) => {
                Ok(i64::from_be_bytes(b.try_into().map_err(|_| bad("int8"))?).into())
            }
            Some(&Type::FLOAT4) => {
                Ok(f32::from_be_bytes(b.try_into().map_err(|_| bad("float4"))?).into())
            }
            Some(&Type::FLOAT8) => {
                Ok(f64::from_be_bytes(b.try_into().map_err(|_| bad("float8"))?).into())
            }
            Some(&Type::BOOL) => Ok(Value::Bool(b.first() == Some(&1))),
            Some(&Type::TEXT | &Type::VARCHAR) => {
                Ok(String::from_utf8_lossy(b).into_owned().into())
            }
            _ => Err(Refusal::Unsupported(
                "binary-format parameters are supported for int2/4/8, float4/8, bool and text"
                    .into(),
            )),
        };
    }
    let s = String::from_utf8_lossy(b).into_owned();
    let number = |s: &str| {
        s.parse::<i64>()
            .map(Value::from)
            .or_else(|_| s.parse::<f64>().map(Value::from))
    };
    match ty {
        Some(
            &Type::INT2
            | &Type::INT4
            | &Type::INT8
            | &Type::FLOAT4
            | &Type::FLOAT8
            | &Type::NUMERIC,
        ) => number(&s).map_err(|_| bad("numeric")),
        Some(&Type::BOOL) => Ok(Value::Bool(matches!(
            s.as_str(),
            "t" | "true" | "1" | "on" | "yes"
        ))),
        Some(&Type::UNKNOWN) | None => Ok(number(&s).unwrap_or(Value::String(s))),
        Some(_) => Ok(Value::String(s)),
    }
}

fn bound(portal: &Portal<String>) -> Result<Vec<Value>, Refusal> {
    portal
        .parameters
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let ty = portal
                .statement
                .parameter_types
                .get(i)
                .and_then(Option::as_ref);
            bind_value(raw.as_deref(), ty, portal.parameter_format.format_for(i))
        })
        .collect()
}

#[async_trait]
impl<B: Backend> ExtendedQueryHandler for Handler<B> {
    type Statement = String;
    type QueryParser = NoopQueryParser;

    fn query_parser(&self) -> Arc<Self::QueryParser> {
        self.parser.clone()
    }

    async fn do_describe_statement<C>(
        &self,
        _client: &mut C,
        target: &StoredStatement<String>,
    ) -> PgWireResult<DescribeStatementResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = String>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let n = placeholder_count(&target.statement);
        let parameters = (0..n)
            .map(|i| {
                target
                    .parameter_types
                    .get(i)
                    .cloned()
                    .flatten()
                    .unwrap_or(Type::TEXT)
            })
            .collect();
        // A placeholder shaped as 0 translates wherever a literal is allowed.
        let dummy = vec![Value::from(0); n];
        let fields = match self.exec(&target.statement, &dummy, true).await.pop() {
            Some(Out::Table(t)) => fields(&t).as_ref().clone(),
            Some(Out::Error(r)) => return Err(user_error(&r)),
            _ => vec![],
        };
        Ok(DescribeStatementResponse::new(parameters, fields))
    }

    async fn do_describe_portal<C>(
        &self,
        _client: &mut C,
        target: &Portal<String>,
    ) -> PgWireResult<DescribePortalResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = String>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        if binary_requested(&target.result_column_format) {
            return Err(no_binary());
        }
        let params = bound(target).map_err(|r| user_error(&r))?;
        let fields = match self
            .exec(&target.statement.statement, &params, true)
            .await
            .pop()
        {
            Some(Out::Table(t)) => fields(&t).as_ref().clone(),
            Some(Out::Error(r)) => return Err(user_error(&r)),
            _ => vec![],
        };
        Ok(DescribePortalResponse::new(fields))
    }

    async fn do_query<C>(
        &self,
        _client: &mut C,
        portal: &Portal<String>,
        _max_rows: usize,
    ) -> PgWireResult<PgResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = String>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        if binary_requested(&portal.result_column_format) {
            return Err(no_binary());
        }
        let params = bound(portal).map_err(|r| user_error(&r))?;
        let out = self
            .exec(&portal.statement.statement, &params, false)
            .await
            .pop()
            .unwrap_or(Out::Empty);
        respond(out)
    }
}
