//! The non-semantic statements a SQL client sends around its queries (⚠8):
//! session chatter, `SHOW`, constant `SELECT`s, and `information_schema`.
//! The supported list is in the crate docs; everything else is refused.

use semantic_gate_core::metadata::{Metadata, ValueType};
use serde_json::Value;
use sqlparser::ast::{
    self, BinaryOperator, Expr, GroupByExpr, ObjectNamePart, OrderByKind, SelectItem, SetExpr,
    Statement, TableFactor, UnaryOperator,
};

use crate::translate::{Cx, name_of, unsupported};
use crate::{Refusal, Table};

const VERSION: &str = "PostgreSQL 16.0 (semantic-gate)";

/// What a catalog statement produced.
pub(crate) enum Outcome {
    /// A command completion tag, e.g. `SET`; `BEGIN`/`COMMIT`/`ROLLBACK`
    /// also move the transaction state.
    Command(&'static str),
    /// Rows.
    Table(Table),
}

/// `None` when the statement is a `SELECT` over the namespace — semantic SQL.
pub(crate) fn handle(
    stmt: &Statement,
    md: &Metadata,
    namespace: &str,
    params: &[Value],
) -> Option<Result<Outcome, Refusal>> {
    let cmd = |tag| Some(Ok(Outcome::Command(tag)));
    match stmt {
        Statement::Set(_) => cmd("SET"),
        Statement::Reset(_) => cmd("RESET"),
        Statement::StartTransaction { .. } => cmd("BEGIN"),
        Statement::Commit { .. } => cmd("COMMIT"),
        Statement::Rollback { .. } => cmd("ROLLBACK"),
        Statement::Discard { .. } => cmd("DISCARD ALL"),
        Statement::Deallocate { .. } => cmd("DEALLOCATE"),
        Statement::ShowVariable { variable } => {
            let name = variable.iter().map(name_of).collect::<Vec<_>>().join(" ");
            Some(show(&name))
        }
        Statement::Query(q) => {
            let SetExpr::Select(sel) = q.body.as_ref() else {
                return None;
            };
            let cx = Cx { md, params };
            match sel.from.as_slice() {
                [] => Some(scalar(&cx, namespace, sel).map(Outcome::Table)),
                [t] => {
                    let TableFactor::Table { name, .. } = &t.relation else {
                        return None;
                    };
                    let parts: Vec<String> = name
                        .0
                        .iter()
                        .map(|p| match p {
                            ObjectNamePart::Identifier(i) => name_of(i),
                            _ => String::new(),
                        })
                        .collect();
                    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
                    let rows = match parts.as_slice() {
                        [.., "information_schema", "tables"] => tables(namespace),
                        [.., "information_schema", "columns"] => columns(md, namespace),
                        [.., "information_schema", other] => {
                            return Some(Err(unsupported(format!(
                                "information_schema.{other} is not emulated; tables and columns are"
                            ))));
                        }
                        [.., "pg_catalog", other] => {
                            return Some(Err(unsupported(format!(
                                "pg_catalog.{other} is not emulated; use information_schema.tables/columns"
                            ))));
                        }
                        _ => return None,
                    };
                    Some(select_from(&cx, q, sel, rows).map(Outcome::Table))
                }
                _ => None,
            }
        }
        _ => Some(Err(unsupported(
            "this statement is not supported: a namespace is queried with SELECT",
        ))),
    }
}

fn text_table(name: &str, v: &str) -> Table {
    Table {
        columns: vec![(name.into(), ValueType::String)],
        rows: vec![vec![Value::from(v)]],
    }
}

fn show(name: &str) -> Result<Outcome, Refusal> {
    let (col, v) = match name {
        "server_version" => ("server_version", "16.0"),
        "server_encoding" => ("server_encoding", "UTF8"),
        "client_encoding" => ("client_encoding", "UTF8"),
        "datestyle" => ("DateStyle", "ISO, MDY"),
        "timezone" | "time zone" => ("TimeZone", "UTC"),
        "standard_conforming_strings" => ("standard_conforming_strings", "on"),
        "integer_datetimes" => ("integer_datetimes", "on"),
        "search_path" => ("search_path", "public"),
        "transaction isolation level" | "transaction_isolation" => {
            ("transaction_isolation", "read committed")
        }
        other => {
            return Err(unsupported(format!(
                "SHOW {other} is not emulated; see the crate docs for the list"
            )));
        }
    };
    Ok(Outcome::Table(text_table(col, v)))
}

/// `SELECT <constants and a few session functions>` with no `FROM`.
fn scalar(cx: &Cx<'_>, ns: &str, sel: &ast::Select) -> Result<Table, Refusal> {
    if sel.selection.is_some() {
        return Err(unsupported("WHERE without FROM is not supported"));
    }
    let mut columns = Vec::new();
    let mut row = Vec::new();
    for item in &sel.projection {
        let (e, alias) = match item {
            SelectItem::UnnamedExpr(e) => (e, None),
            SelectItem::ExprWithAlias { expr, alias } => (expr, Some(name_of(alias))),
            _ => return Err(unsupported("`*` needs a FROM")),
        };
        let (default, v) = scalar_expr(cx, ns, e)?;
        let ty = match &v {
            Value::Number(n) if n.is_i64() => ValueType::Integer,
            Value::Number(_) => ValueType::Number,
            Value::Bool(_) => ValueType::Boolean,
            _ => ValueType::String,
        };
        columns.push((alias.unwrap_or_else(|| default.into()), ty));
        row.push(v);
    }
    Ok(Table {
        columns,
        rows: vec![row],
    })
}

fn scalar_expr(cx: &Cx<'_>, ns: &str, e: &Expr) -> Result<(&'static str, Value), Refusal> {
    match e {
        Expr::Nested(e) => scalar_expr(cx, ns, e),
        Expr::Cast { expr, .. } => scalar_expr(cx, ns, expr),
        Expr::Function(f) => {
            let name = f.name.to_string().to_lowercase();
            let name = name.strip_prefix("pg_catalog.").unwrap_or(&name).to_owned();
            let arg = || match &f.args {
                ast::FunctionArguments::List(l) => match l.args.as_slice() {
                    [ast::FunctionArg::Unnamed(ast::FunctionArgExpr::Expr(a))] => cx.literal(a),
                    _ => Err(unsupported("unexpected function arguments")),
                },
                _ => Ok(Value::Null),
            };
            match name.as_str() {
                "version" => Ok(("version", VERSION.into())),
                "current_schema" => Ok(("current_schema", "public".into())),
                "current_database" => Ok(("current_database", ns.into())),
                "current_user" | "session_user" => Ok(("current_user", "semantic_gate".into())),
                "pg_backend_pid" => Ok(("pg_backend_pid", 1.into())),
                "current_setting" => {
                    let Value::String(s) = arg()? else {
                        return Err(unsupported("current_setting takes a setting name"));
                    };
                    match show(&s.to_lowercase())? {
                        Outcome::Table(t) => Ok(("current_setting", t.rows[0][0].clone())),
                        Outcome::Command(_) => unreachable!("show returns a table"),
                    }
                }
                other => Err(unsupported(format!("function {other}() is not emulated"))),
            }
        }
        Expr::Identifier(i) if matches!(name_of(i).as_str(), "current_user" | "session_user") => {
            Ok(("current_user", "semantic_gate".into()))
        }
        e => Ok(("?column?", cx.literal(e)?)),
    }
}

fn tables(ns: &str) -> Table {
    Table {
        columns: ["table_catalog", "table_schema", "table_name", "table_type"]
            .map(|c| (c.to_owned(), ValueType::String))
            .to_vec(),
        rows: vec![vec![
            ns.into(),
            "public".into(),
            ns.into(),
            "BASE TABLE".into(),
        ]],
    }
}

fn columns(md: &Metadata, ns: &str) -> Table {
    let mut columns: Vec<(String, ValueType)> = [
        "table_catalog",
        "table_schema",
        "table_name",
        "column_name",
        "ordinal_position",
        "is_nullable",
        "data_type",
    ]
    .map(|c| (c.to_owned(), ValueType::String))
    .to_vec();
    columns[4].1 = ValueType::Integer;
    let members = md
        .dimensions
        .iter()
        .map(|d| (&d.name, d.value_type))
        .chain(md.metrics.iter().map(|m| (&m.name, m.value_type)));
    let rows = members
        .enumerate()
        .map(|(i, (name, ty))| {
            let pg = match ty {
                ValueType::String => "text",
                ValueType::Integer => "bigint",
                ValueType::Number => "double precision",
                ValueType::Boolean => "boolean",
                ValueType::Date => "date",
                ValueType::Timestamp => "timestamp with time zone",
            };
            vec![
                ns.into(),
                "public".into(),
                ns.into(),
                name.as_str().into(),
                (i + 1).into(),
                "YES".into(),
                pg.into(),
            ]
        })
        .collect();
    Table { columns, rows }
}

/// A tiny evaluator over an in-memory table: projection, `WHERE`, `ORDER BY`
/// a column, `LIMIT`.
fn select_from(
    cx: &Cx<'_>,
    q: &ast::Query,
    sel: &ast::Select,
    base: Table,
) -> Result<Table, Refusal> {
    if sel.distinct.is_some()
        || sel.having.is_some()
        || sel.qualify.is_some()
        || !matches!(&sel.group_by, GroupByExpr::Expressions(g, _) if g.is_empty())
    {
        return Err(unsupported(
            "DISTINCT, GROUP BY, HAVING, QUALIFY over information_schema are not supported",
        ));
    }
    let col = |name: &str| base.columns.iter().position(|(n, _)| n == name);
    let pos = |e: &Expr| -> Result<usize, Refusal> {
        let name = match e {
            Expr::Identifier(i) => name_of(i),
            Expr::CompoundIdentifier(p) => p.last().map(name_of).unwrap_or_default(),
            _ => return Err(unsupported("expected a column of information_schema")),
        };
        col(&name).ok_or_else(|| unsupported(format!("information_schema has no column `{name}`")))
    };

    let mut rows: Vec<&Vec<Value>> = Vec::new();
    for r in &base.rows {
        let keep = match &sel.selection {
            None => true,
            Some(w) => eval(cx, w, r, &pos)?,
        };
        if keep {
            rows.push(r);
        }
    }

    if let Some(ob) = &q.order_by {
        let OrderByKind::Expressions(keys) = &ob.kind else {
            return Err(unsupported("ORDER BY ALL is not supported"));
        };
        let mut idx = Vec::new();
        for k in keys {
            let desc = matches!(k.options.sort, Some(ast::OrderBySort::Desc));
            idx.push((pos(&k.expr)?, desc));
        }
        rows.sort_by(|a, b| {
            for &(i, desc) in &idx {
                let o = cmp(&a[i], &b[i]);
                if o.is_ne() {
                    return if desc { o.reverse() } else { o };
                }
            }
            std::cmp::Ordering::Equal
        });
    }
    if let Some(ast::LimitClause::LimitOffset {
        limit: Some(l),
        offset: None,
        ..
    }) = &q.limit_clause
        && let Value::Number(n) = cx.literal(l)?
    {
        rows.truncate(n.as_u64().unwrap_or(u64::MAX) as usize);
    }

    // projection
    enum P {
        Col(usize),
        Const(Value),
    }
    let mut out_cols = Vec::new();
    let mut plan = Vec::new();
    for item in &sel.projection {
        match item {
            SelectItem::Wildcard(_) => {
                for (i, c) in base.columns.iter().enumerate() {
                    out_cols.push(c.clone());
                    plan.push(P::Col(i));
                }
            }
            SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => {
                let alias = match item {
                    SelectItem::ExprWithAlias { alias, .. } => Some(name_of(alias)),
                    _ => None,
                };
                if let Ok(i) = pos(e) {
                    let (n, t) = &base.columns[i];
                    out_cols.push((alias.unwrap_or_else(|| n.clone()), *t));
                    plan.push(P::Col(i));
                } else {
                    let v = cx
                        .literal(e)
                        .map_err(|_| unsupported("expected a column or a literal"))?;
                    let t = if v.is_number() {
                        ValueType::Integer
                    } else {
                        ValueType::String
                    };
                    out_cols.push((alias.unwrap_or_else(|| "?column?".into()), t));
                    plan.push(P::Const(v));
                }
            }
            _ => return Err(unsupported("this select-list form is not supported")),
        }
    }
    let rows = rows
        .iter()
        .map(|r| {
            plan.iter()
                .map(|p| match p {
                    P::Col(i) => r[*i].clone(),
                    P::Const(v) => v.clone(),
                })
                .collect()
        })
        .collect();
    Ok(Table {
        columns: out_cols,
        rows,
    })
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

fn cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        _ => text(a).cmp(&text(b)),
    }
}

fn eval(
    cx: &Cx<'_>,
    e: &Expr,
    row: &[Value],
    pos: &dyn Fn(&Expr) -> Result<usize, Refusal>,
) -> Result<bool, Refusal> {
    let operand = |e: &Expr| -> Result<Value, Refusal> {
        match pos(e) {
            Ok(i) => Ok(row[i].clone()),
            Err(_) => cx.literal(e),
        }
    };
    match e {
        Expr::Nested(e) => eval(cx, e, row, pos),
        Expr::UnaryOp {
            op: UnaryOperator::Not,
            expr,
        } => Ok(!eval(cx, expr, row, pos)?),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => Ok(eval(cx, left, row, pos)? && eval(cx, right, row, pos)?),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::Or,
            right,
        } => Ok(eval(cx, left, row, pos)? || eval(cx, right, row, pos)?),
        Expr::BinaryOp { left, op, right } => {
            let (a, b) = (operand(left)?, operand(right)?);
            if a.is_null() || b.is_null() {
                return Ok(false);
            }
            let o = cmp(&a, &b);
            Ok(match op {
                BinaryOperator::Eq => o.is_eq(),
                BinaryOperator::NotEq => o.is_ne(),
                BinaryOperator::Lt => o.is_lt(),
                BinaryOperator::LtEq => o.is_le(),
                BinaryOperator::Gt => o.is_gt(),
                BinaryOperator::GtEq => o.is_ge(),
                _ => {
                    return Err(unsupported(format!(
                        "operator `{op}` over information_schema"
                    )));
                }
            })
        }
        Expr::IsNull(e) => Ok(operand(e)?.is_null()),
        Expr::IsNotNull(e) => Ok(!operand(e)?.is_null()),
        Expr::InList {
            expr,
            list,
            negated,
        } => {
            let v = operand(expr)?;
            let mut hit = false;
            for x in list {
                hit |= cmp(&v, &operand(x)?).is_eq();
            }
            Ok(hit != *negated)
        }
        Expr::Like {
            negated,
            expr,
            pattern,
            escape_char: None,
            any: false,
        } => {
            let (v, p) = (text(&operand(expr)?), text(&operand(pattern)?));
            Ok(glob(p.as_bytes(), v.as_bytes()) != *negated)
        }
        _ => Err(unsupported(
            "this WHERE expression over information_schema is not supported",
        )),
    }
}

/// `LIKE` with `%` and `_`.
fn glob(p: &[u8], s: &[u8]) -> bool {
    match p.split_first() {
        None => s.is_empty(),
        Some((b'%', rest)) => (0..=s.len()).any(|i| glob(rest, &s[i..])),
        Some((b'_', rest)) => !s.is_empty() && glob(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && glob(rest, &s[1..]),
    }
}
