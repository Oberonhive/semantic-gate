//! Semantic SQL → [`SemanticQuery`] (the grammar is in the crate docs).

use semantic_gate_core::ErrorCode;
use semantic_gate_core::metadata::{
    DimensionDecl, Metadata, MetricDecl, ModifierDecl, ModifierOutput, ValueType,
};
use semantic_gate_core::query::{
    Direction, Filter, FilterOp, Logic, ModifierCall, OrderBy, Predicate, SemanticQuery,
};
use serde_json::{Map, Value};
use sqlparser::ast::{
    self, BinaryOperator, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr,
    Ident, LimitClause, OrderByKind, SelectItem, SetExpr, TableFactor, UnaryOperator,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use crate::{Projection, Refusal, Statement};

/// Wrappers BI tools put around a metric; the metric's own definition
/// aggregates, so they are accepted and dropped.
const WRAPPERS: [&str; 6] = ["measure", "sum", "min", "max", "avg", "count"];

/// Translate one semantic SQL `SELECT` against the namespace's metadata.
pub fn translate(sql: &str, md: &Metadata) -> Result<Statement, Refusal> {
    let mut statements = parse(sql)?;
    match (statements.pop(), statements.is_empty()) {
        (Some(ast::Statement::Query(q)), true) => query(&q, md, &[]),
        (Some(_), true) => Err(unsupported("only SELECT is semantic SQL")),
        _ => Err(unsupported("exactly one statement is expected")),
    }
}

pub(crate) fn parse(sql: &str) -> Result<Vec<ast::Statement>, Refusal> {
    Parser::parse_sql(&PostgreSqlDialect {}, sql).map_err(|e| Refusal::Syntax(e.to_string()))
}

pub(crate) fn unsupported(what: impl Into<String>) -> Refusal {
    Refusal::Unsupported(what.into())
}

fn refuse(code: ErrorCode, message: impl Into<String>, hint: Option<String>) -> Refusal {
    Refusal::Code {
        code,
        message: message.into(),
        hint,
        request_id: None,
    }
}

/// An unquoted identifier folds to lower case, a quoted one is exact.
pub(crate) fn name_of(i: &Ident) -> String {
    if i.quote_style.is_some() {
        i.value.clone()
    } else {
        i.value.to_lowercase()
    }
}

/// Translate a parsed `SELECT` over the namespace; `$n` placeholders read
/// `params[n - 1]`.
pub(crate) fn query(q: &ast::Query, md: &Metadata, params: &[Value]) -> Result<Statement, Refusal> {
    if q.with.is_some() {
        return Err(unsupported("WITH is not semantic SQL"));
    }
    if q.fetch.is_some() || !q.locks.is_empty() || q.for_clause.is_some() || q.settings.is_some() {
        return Err(unsupported("FETCH, FOR, SETTINGS are not semantic SQL"));
    }
    let SetExpr::Select(select) = q.body.as_ref() else {
        return Err(unsupported(
            "set operations, VALUES and nested queries are not semantic SQL",
        ));
    };
    if select.distinct.is_some() {
        return Err(unsupported(
            "DISTINCT is not semantic SQL: dimensions already group",
        ));
    }
    if select.having.is_some() {
        return Err(unsupported(
            "HAVING is not semantic SQL: filter a metric in WHERE",
        ));
    }
    if select.top.is_some()
        || select.into.is_some()
        || !select.lateral_views.is_empty()
        || select.prewhere.is_some()
        || !select.named_window.is_empty()
    {
        return Err(unsupported("this SELECT clause is not semantic SQL"));
    }
    match select.from.as_slice() {
        [t] if t.joins.is_empty()
            && matches!(t.relation, TableFactor::Table { args: None, .. }) => {}
        [_] => {
            return Err(unsupported(
                "joins and subqueries are not semantic SQL: select FROM the namespace",
            ));
        }
        _ => {
            return Err(unsupported(
                "semantic SQL selects FROM exactly one table: the namespace",
            ));
        }
    }

    let cx = Cx { md, params };
    let mut st = State::default();

    // select list
    let mut items = Vec::new();
    for item in &select.projection {
        match item {
            SelectItem::UnnamedExpr(e) => items.push((cx.item(e)?, None)),
            SelectItem::ExprWithAlias { expr, alias } => {
                items.push((cx.item(expr)?, Some(name_of(alias))));
            }
            SelectItem::Wildcard(_) => {
                for d in &md.dimensions {
                    items.push((Item::Dim(d), None));
                }
                for m in &md.metrics {
                    items.push((Item::Metric(m), None));
                }
            }
            _ => return Err(unsupported("this select-list form is not semantic SQL")),
        }
    }
    if items.is_empty() {
        return Err(unsupported("the select list is empty"));
    }
    let mut columns = Vec::new();
    for (item, alias) in &items {
        if let Item::Modifier { decl, metric, .. } = item {
            if decl.output == ModifierOutput::Rows {
                return Err(refuse(
                    ErrorCode::InvalidComposition,
                    format!("`{}` adds no column, it changes the row set", decl.name),
                    Some(format!("write it as QUALIFY {}(…)", decl.name)),
                ));
            }
            if metric.is_none() {
                return Err(refuse(
                    ErrorCode::InvalidParams,
                    format!(
                        "`{}` in the select list takes the metric as its first argument",
                        decl.name
                    ),
                    Some(format!("{}(<metric>, …)", decl.name)),
                ));
            }
        }
        let (source, value_type) = st.add(item);
        columns.push(Projection {
            name: alias.clone().unwrap_or_else(|| source.clone()),
            source,
            value_type,
        });
    }

    // QUALIFY
    if let Some(q) = &select.qualify {
        let mut calls = Vec::new();
        conjuncts(q, &mut calls);
        for e in calls {
            let item = cx.item(e)?;
            if !matches!(item, Item::Modifier { .. }) {
                return Err(unsupported("QUALIFY takes modifier calls only"));
            }
            st.add(&item);
        }
    }

    // GROUP BY
    match &select.group_by {
        GroupByExpr::All(m) if m.is_empty() => {}
        GroupByExpr::Expressions(exprs, m) if m.is_empty() && exprs.is_empty() => {}
        GroupByExpr::Expressions(exprs, m) if m.is_empty() => {
            let mut listed = Vec::new();
            for e in exprs {
                let name = match e {
                    Expr::Value(v) => match &v.value {
                        ast::Value::Number(n, _) => n
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| columns.get(i.wrapping_sub(1)))
                            .map(|c| c.source.clone()),
                        _ => None,
                    },
                    e => column_ref(e).map(|p| p.last().cloned().unwrap_or_default()),
                };
                listed.push(name.unwrap_or_default());
            }
            let mut want = st.dimensions.clone();
            let mut got = listed.clone();
            want.sort();
            got.sort();
            got.dedup();
            if want != got {
                return Err(refuse(
                    ErrorCode::InvalidComposition,
                    format!(
                        "GROUP BY lists [{}], the selected dimensions are [{}]",
                        listed.join(", "),
                        st.dimensions.join(", ")
                    ),
                    Some(
                        "GROUP BY is implied by the dimensions; list exactly them or omit it"
                            .into(),
                    ),
                ));
            }
        }
        _ => return Err(unsupported("GROUP BY modifiers are not semantic SQL")),
    }

    // WHERE
    let mut query_params = Map::new();
    let filters = match &select.selection {
        None => None,
        Some(w) => {
            let mut parts = Vec::new();
            conjuncts(w, &mut parts);
            let mut filters = Vec::new();
            for e in parts {
                if let Some((key, value)) = cx.param_setting(e)? {
                    query_params.insert(key, value);
                } else {
                    filters.push(cx.filter(e)?);
                }
            }
            match filters.len() {
                0 => None,
                1 => filters.pop(),
                _ => Some(Filter::Combine {
                    op: Logic::And,
                    items: filters,
                }),
            }
        }
    };

    // ORDER BY
    let mut order = Vec::new();
    if let Some(ob) = &q.order_by {
        let OrderByKind::Expressions(exprs) = &ob.kind else {
            return Err(unsupported("ORDER BY ALL is not semantic SQL"));
        };
        for o in exprs {
            if o.options.nulls_first.is_some() || o.with_fill.is_some() {
                return Err(unsupported(
                    "NULLS FIRST/LAST and WITH FILL are not semantic SQL",
                ));
            }
            let field = cx.order_field(&o.expr, &columns)?;
            let dir = match &o.options.sort {
                None | Some(ast::OrderBySort::Asc) => Direction::Asc,
                Some(ast::OrderBySort::Desc) => Direction::Desc,
                Some(_) => return Err(unsupported("ORDER BY … USING is not semantic SQL")),
            };
            order.push(OrderBy { field, dir });
        }
    }

    // LIMIT
    let limit = match &q.limit_clause {
        None
        | Some(LimitClause::LimitOffset {
            limit: None,
            offset: None,
            ..
        }) => None,
        Some(LimitClause::LimitOffset {
            limit: Some(e),
            offset: None,
            limit_by,
        }) if limit_by.is_empty() => match cx.literal(e)? {
            Value::Number(n) if n.as_u64().is_some() => n.as_u64(),
            _ => {
                return Err(refuse(
                    ErrorCode::InvalidParams,
                    "LIMIT takes a non-negative integer",
                    None,
                ));
            }
        },
        Some(_) => return Err(unsupported("OFFSET and LIMIT BY are not semantic SQL")),
    };

    Ok(Statement {
        query: SemanticQuery {
            metrics: st.metrics,
            dimensions: st.dimensions,
            filters,
            modifiers: st.modifiers,
            params: query_params,
            order,
            limit,
            viz: None,
        },
        columns,
    })
}

enum Item<'a> {
    Dim(&'a DimensionDecl),
    Metric(&'a MetricDecl),
    Modifier {
        decl: &'a ModifierDecl,
        call: ModifierCall,
        metric: Option<&'a MetricDecl>,
    },
}

/// The query being assembled, in textual order.
#[derive(Default)]
struct State {
    metrics: Vec<String>,
    dimensions: Vec<String>,
    modifiers: Vec<ModifierCall>,
}

impl State {
    /// Record an item; returns its response column name and predicted type.
    fn add(&mut self, item: &Item<'_>) -> (String, ValueType) {
        fn push(v: &mut Vec<String>, n: &str) {
            if !v.iter().any(|x| x == n) {
                v.push(n.to_owned());
            }
        }
        match item {
            Item::Dim(d) => {
                push(&mut self.dimensions, &d.name);
                (d.name.clone(), d.value_type)
            }
            Item::Metric(m) => {
                push(&mut self.metrics, &m.name);
                (m.name.clone(), m.value_type)
            }
            Item::Modifier {
                decl, call, metric, ..
            } => {
                self.modifiers.push(call.clone());
                let Some(m) = metric else {
                    return (decl.name.clone(), ValueType::Number);
                };
                push(&mut self.metrics, &m.name);
                let ty = match decl.output {
                    ModifierOutput::Rank => ValueType::Integer,
                    _ => ValueType::Number,
                };
                (format!("{}({})", decl.name, m.name), ty)
            }
        }
    }
}

pub(crate) struct Cx<'a> {
    pub(crate) md: &'a Metadata,
    pub(crate) params: &'a [Value],
}

/// The parts of a plain or qualified column reference, normalised.
fn column_ref(e: &Expr) -> Option<Vec<String>> {
    match e {
        Expr::Identifier(i) => Some(vec![name_of(i)]),
        Expr::CompoundIdentifier(p) => Some(p.iter().map(name_of).collect()),
        Expr::Nested(e) => column_ref(e),
        Expr::Cast { expr, .. } => column_ref(expr),
        _ => None,
    }
}

/// Split a conjunction into its conjuncts.
fn conjuncts<'e>(e: &'e Expr, out: &mut Vec<&'e Expr>) {
    match e {
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => {
            conjuncts(left, out);
            conjuncts(right, out);
        }
        Expr::Nested(inner)
            if matches!(
                **inner,
                Expr::BinaryOp {
                    op: BinaryOperator::And,
                    ..
                }
            ) =>
        {
            conjuncts(inner, out);
        }
        e => out.push(e),
    }
}

impl<'a> Cx<'a> {
    fn dimension(&self, name: &str) -> Option<&'a DimensionDecl> {
        self.md.dimensions.iter().find(|d| d.name == name)
    }

    fn metric(&self, name: &str) -> Option<&'a MetricDecl> {
        self.md.metrics.iter().find(|m| m.name == name)
    }

    fn known(&self) -> String {
        fn list<'x>(it: impl Iterator<Item = &'x str>) -> String {
            let v: Vec<_> = it.take(20).collect();
            v.join(", ")
        }
        format!(
            "dimensions: [{}]; metrics: [{}]",
            list(self.md.dimensions.iter().map(|d| d.name.as_str())),
            list(self.md.metrics.iter().map(|m| m.name.as_str()))
        )
    }

    fn unknown_member(&self, name: &str) -> Refusal {
        refuse(
            ErrorCode::UnknownDimension,
            format!("`{name}` is neither a dimension nor a metric of this namespace"),
            Some(self.known()),
        )
    }

    fn unknown_metric(&self, name: &str) -> Refusal {
        refuse(
            ErrorCode::UnknownMetric,
            format!("`{name}` is not a metric of this namespace"),
            Some(self.known()),
        )
    }

    fn unknown_modifier(&self, name: &str) -> Refusal {
        let names: Vec<_> = self
            .md
            .modifiers
            .iter()
            .map(|m| m.name.as_str())
            .take(30)
            .collect();
        refuse(
            ErrorCode::UnknownModifier,
            format!(
                "`{name}` is not a modifier of this namespace, nor a metric wrapper (MEASURE, SUM, MIN, MAX, AVG, COUNT)"
            ),
            Some(format!("modifiers: [{}]", names.join(", "))),
        )
    }

    /// One select-list or QUALIFY entry.
    fn item(&self, e: &Expr) -> Result<Item<'a>, Refusal> {
        match e {
            Expr::Nested(e) => self.item(e),
            Expr::Cast { expr, .. } => self.item(expr),
            Expr::Identifier(_) | Expr::CompoundIdentifier(_) => {
                let name = column_ref(e)
                    .and_then(|p| p.last().cloned())
                    .unwrap_or_default();
                if let Some(d) = self.dimension(&name) {
                    Ok(Item::Dim(d))
                } else if let Some(m) = self.metric(&name) {
                    Ok(Item::Metric(m))
                } else {
                    Err(self.unknown_member(&name))
                }
            }
            Expr::Function(f) => {
                let [ast::ObjectNamePart::Identifier(id)] = f.name.0.as_slice() else {
                    return Err(unsupported("qualified function names are not semantic SQL"));
                };
                let fname = name_of(id);
                if f.over.is_some() || f.filter.is_some() || !f.within_group.is_empty() {
                    return Err(unsupported(
                        "window functions and FILTER are not semantic SQL; modifiers are the vocabulary",
                    ));
                }
                let FunctionArguments::List(list) = &f.args else {
                    return Err(unsupported("a function call is expected here"));
                };
                if list.duplicate_treatment.is_some() || !list.clauses.is_empty() {
                    return Err(unsupported(
                        "DISTINCT and argument clauses are not semantic SQL",
                    ));
                }
                if let Some(decl) = self.md.modifiers.iter().find(|m| m.name == fname) {
                    return self.modifier(decl, &list.args);
                }
                if WRAPPERS.contains(&fname.as_str()) {
                    return match list.args.as_slice() {
                        [FunctionArg::Unnamed(FunctionArgExpr::Expr(a))] => {
                            self.metric_arg(a).map(Item::Metric)
                        }
                        _ => Err(unsupported(
                            "COUNT(*) and multi-argument aggregates are not semantic SQL; name the metric",
                        )),
                    };
                }
                Err(self.unknown_modifier(&fname))
            }
            _ => Err(unsupported(
                "only dimensions, metrics and modifier calls are semantic SQL select-list entries",
            )),
        }
    }

    /// A metric, bare or in a BI wrapper.
    fn metric_arg(&self, e: &Expr) -> Result<&'a MetricDecl, Refusal> {
        if let Expr::Function(f) = e
            && let [ast::ObjectNamePart::Identifier(id)] = f.name.0.as_slice()
            && WRAPPERS.contains(&name_of(id).as_str())
            && let FunctionArguments::List(l) = &f.args
            && let [FunctionArg::Unnamed(FunctionArgExpr::Expr(inner))] = l.args.as_slice()
        {
            return self.metric_arg(inner);
        }
        let Some(name) = column_ref(e).and_then(|p| p.last().cloned()) else {
            return Err(unsupported("expected a metric name"));
        };
        self.metric(&name).ok_or_else(|| self.unknown_metric(&name))
    }

    fn modifier(&self, decl: &'a ModifierDecl, args: &[FunctionArg]) -> Result<Item<'a>, Refusal> {
        let mut metric = None;
        let mut params = Map::new();
        for (i, a) in args.iter().enumerate() {
            match a {
                FunctionArg::Unnamed(FunctionArgExpr::Expr(e)) if i == 0 => {
                    metric = Some(self.metric_arg(e)?);
                }
                FunctionArg::Named {
                    name,
                    arg: FunctionArgExpr::Expr(e),
                    operator:
                        ast::FunctionArgOperator::RightArrow | ast::FunctionArgOperator::Assignment,
                } => {
                    params.insert(name_of(name), self.literal(e)?);
                }
                FunctionArg::ExprNamed {
                    name: Expr::Identifier(name),
                    arg: FunctionArgExpr::Expr(e),
                    operator:
                        ast::FunctionArgOperator::RightArrow | ast::FunctionArgOperator::Assignment,
                } => {
                    params.insert(name_of(name), self.literal(e)?);
                }
                _ => {
                    return Err(refuse(
                        ErrorCode::InvalidParams,
                        format!(
                            "`{}` takes the metric first, then `name => value` parameters",
                            decl.name
                        ),
                        None,
                    ));
                }
            }
        }
        Ok(Item::Modifier {
            decl,
            call: ModifierCall {
                name: decl.name.clone(),
                params,
            },
            metric,
        })
    }

    /// `params.x = lit` / `params.member.x = lit` → (key, value).
    fn param_setting(&self, e: &Expr) -> Result<Option<(String, Value)>, Refusal> {
        let Expr::BinaryOp {
            left,
            op: BinaryOperator::Eq,
            right,
        } = e
        else {
            return Ok(None);
        };
        let key = |side: &Expr| {
            column_ref(side)
                .filter(|p| p.len() >= 2 && p[0] == "params")
                .map(|p| p[1..].join("."))
        };
        match (key(left), key(right)) {
            (Some(k), None) => Ok(Some((k, self.literal(right)?))),
            (None, Some(k)) => Ok(Some((k, self.literal(left)?))),
            _ => Ok(None),
        }
    }

    fn field(&self, e: &Expr) -> Option<Result<String, Refusal>> {
        let p = column_ref(e)?;
        if p.first().map(String::as_str) == Some("params") && p.len() >= 2 {
            return Some(Err(refuse(
                ErrorCode::InvalidParams,
                "`params.*` is set with `params.<name> = <literal>` as a top-level AND conjunct of WHERE, nowhere else",
                None,
            )));
        }
        let name = p.last()?.clone();
        Some(
            if self.dimension(&name).is_some() || self.metric(&name).is_some() {
                Ok(name)
            } else {
                Err(self.unknown_member(&name))
            },
        )
    }

    fn filter(&self, e: &Expr) -> Result<Filter, Refusal> {
        let pred = |field: String, op: FilterOp, value: Option<Value>| {
            Filter::Predicate(Predicate { field, op, value })
        };
        let not = |f: Filter| Filter::Combine {
            op: Logic::Not,
            items: vec![f],
        };
        let field = |e: &Expr| {
            self.field(e).unwrap_or_else(|| {
                Err(unsupported(
                    "a predicate compares a dimension or a metric with literals",
                ))
            })
        };
        match e {
            Expr::Nested(e) => self.filter(e),
            Expr::UnaryOp {
                op: UnaryOperator::Not,
                expr,
            } => Ok(not(self.filter(expr)?)),
            Expr::BinaryOp {
                left,
                op: op @ (BinaryOperator::And | BinaryOperator::Or),
                right,
            } => {
                let logic = if matches!(op, BinaryOperator::And) {
                    Logic::And
                } else {
                    Logic::Or
                };
                let mut items = Vec::new();
                for side in [left, right] {
                    match self.filter(side)? {
                        Filter::Combine { op, items: inner } if op == logic => items.extend(inner),
                        f => items.push(f),
                    }
                }
                Ok(Filter::Combine { op: logic, items })
            }
            Expr::BinaryOp { left, op, right } => {
                use BinaryOperator as B;
                let (op, flipped) = match op {
                    B::Eq => (FilterOp::Eq, FilterOp::Eq),
                    B::NotEq => (FilterOp::Ne, FilterOp::Ne),
                    B::Gt => (FilterOp::Gt, FilterOp::Lt),
                    B::GtEq => (FilterOp::Ge, FilterOp::Le),
                    B::Lt => (FilterOp::Lt, FilterOp::Gt),
                    B::LtEq => (FilterOp::Le, FilterOp::Ge),
                    _ => {
                        return Err(unsupported(format!(
                            "operator `{op}` is not in the filter vocabulary"
                        )));
                    }
                };
                let (f, op, v) = if column_ref(left).is_some() {
                    (field(left)?, op, self.literal(right)?)
                } else {
                    (field(right)?, flipped, self.literal(left)?)
                };
                if v.is_null() {
                    return Err(unsupported(
                        "comparison with NULL is never true; use IS [NOT] NULL",
                    ));
                }
                Ok(pred(f, op, Some(v)))
            }
            Expr::IsNull(e) => Ok(pred(field(e)?, FilterOp::IsNull, None)),
            Expr::IsNotNull(e) => Ok(pred(field(e)?, FilterOp::IsNotNull, None)),
            Expr::InList {
                expr,
                list,
                negated,
            } => {
                let values = list
                    .iter()
                    .map(|e| self.literal(e))
                    .collect::<Result<Vec<_>, _>>()?;
                let op = if *negated {
                    FilterOp::NotIn
                } else {
                    FilterOp::In
                };
                Ok(pred(field(expr)?, op, Some(Value::Array(values))))
            }
            Expr::Between {
                expr,
                negated,
                low,
                high,
            } => {
                let v = Value::Array(vec![self.literal(low)?, self.literal(high)?]);
                let p = pred(field(expr)?, FilterOp::Between, Some(v));
                Ok(if *negated { not(p) } else { p })
            }
            Expr::Like {
                negated,
                any: false,
                expr,
                pattern,
                escape_char: None,
            } => {
                let Value::String(pat) = self.literal(pattern)? else {
                    return Err(unsupported("LIKE takes a string pattern"));
                };
                let (op, text) = like(&pat)?;
                let p = pred(field(expr)?, op, Some(Value::String(text)));
                Ok(if *negated { not(p) } else { p })
            }
            Expr::ILike { .. } => Err(unsupported(
                "ILIKE is not in the filter vocabulary; LIKE 'x%' and LIKE '%x%' are",
            )),
            _ => Err(unsupported(
                "this WHERE expression is not in the filter vocabulary",
            )),
        }
    }

    /// An `ORDER BY` key → the response column name.
    fn order_field(&self, e: &Expr, columns: &[Projection]) -> Result<String, Refusal> {
        if let Expr::Value(v) = e
            && let ast::Value::Number(n, _) = &v.value
        {
            return n
                .parse::<usize>()
                .ok()
                .and_then(|i| columns.get(i.wrapping_sub(1)))
                .map(|c| c.source.clone())
                .ok_or_else(|| {
                    refuse(
                        ErrorCode::InvalidParams,
                        format!("ORDER BY position {n} is not in the select list"),
                        None,
                    )
                });
        }
        if let Expr::Identifier(id) = e {
            let n = name_of(id);
            if let Some(c) = columns.iter().find(|c| c.name == n) {
                return Ok(c.source.clone());
            }
        }
        match self.item(e)? {
            Item::Dim(d) => Ok(d.name.clone()),
            Item::Metric(m) => Ok(m.name.clone()),
            Item::Modifier {
                decl,
                metric: Some(m),
                ..
            } => Ok(format!("{}({})", decl.name, m.name)),
            Item::Modifier { decl, .. } => Err(refuse(
                ErrorCode::InvalidParams,
                format!("order by `{}(metric)` — name the metric", decl.name),
                None,
            )),
        }
    }

    /// A literal (or a bound `$n`) as JSON.
    pub(crate) fn literal(&self, e: &Expr) -> Result<Value, Refusal> {
        match e {
            Expr::Nested(e) => self.literal(e),
            Expr::Cast { expr, .. } => self.literal(expr),
            Expr::TypedString(t) => self.literal(&Expr::Value(t.value.clone())),
            Expr::UnaryOp {
                op: op @ (UnaryOperator::Minus | UnaryOperator::Plus),
                expr,
            } => match self.literal(expr)? {
                Value::Number(n) if matches!(op, UnaryOperator::Plus) => Ok(Value::Number(n)),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        Ok(Value::from(-i))
                    } else {
                        Ok(Value::from(-n.as_f64().unwrap_or_default()))
                    }
                }
                _ => Err(unsupported("unary sign on a non-number")),
            },
            Expr::Array(a) => Ok(Value::Array(
                a.elem
                    .iter()
                    .map(|e| self.literal(e))
                    .collect::<Result<_, _>>()?,
            )),
            Expr::Value(v) => match &v.value {
                ast::Value::Number(n, _) => n
                    .parse::<i64>()
                    .map(Value::from)
                    .or_else(|_| n.parse::<f64>().map(Value::from))
                    .map_err(|_| Refusal::Syntax(format!("bad number {n}"))),
                ast::Value::SingleQuotedString(s)
                | ast::Value::EscapedStringLiteral(s)
                | ast::Value::NationalStringLiteral(s) => Ok(Value::String(s.clone())),
                ast::Value::Boolean(b) => Ok(Value::Bool(*b)),
                ast::Value::Null => Ok(Value::Null),
                ast::Value::Placeholder(p) => p
                    .strip_prefix('$')
                    .and_then(|n| n.parse::<usize>().ok())
                    .and_then(|n| self.params.get(n.wrapping_sub(1)))
                    .cloned()
                    .ok_or_else(|| {
                        refuse(
                            ErrorCode::InvalidParams,
                            format!("no value is bound for {p}"),
                            None,
                        )
                    }),
                _ => Err(unsupported("this literal form is not semantic SQL")),
            },
            _ => Err(unsupported(format!(
                "`{e}` is not a literal: values in filters and parameters are literals"
            ))),
        }
    }
}

/// `LIKE` pattern → the closed vocabulary.
fn like(pat: &str) -> Result<(FilterOp, String), Refusal> {
    let no = || {
        unsupported(format!(
            "LIKE '{pat}': only 'x%' (starts_with), '%x%' (contains) and a pattern without wildcards (=) are in the filter vocabulary; `_` and `\\` are wildcards/escapes"
        ))
    };
    if pat.contains(['_', '\\']) {
        return Err(no());
    }
    let (lead, rest) = pat.strip_prefix('%').map_or((false, pat), |r| (true, r));
    let (trail, body) = rest.strip_suffix('%').map_or((false, rest), |r| (true, r));
    if body.is_empty() || body.contains('%') {
        return Err(no());
    }
    match (lead, trail) {
        (false, false) => Ok((FilterOp::Eq, body.into())),
        (false, true) => Ok((FilterOp::StartsWith, body.into())),
        (true, true) => Ok((FilterOp::Contains, body.into())),
        (true, false) => Err(no()),
    }
}
