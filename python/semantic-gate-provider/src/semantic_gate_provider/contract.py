"""The Python mirror of the contract (`packages/contract/src/index.ts`, normative).

Messages stay plain dicts on the wire; these types only name their shape. Wire
names are snake_case and an optional field is omitted, never `None`. Where this
module differs from the TypeScript contract, this module is wrong.
"""

from typing import Any, Literal, NotRequired, TypedDict

CONTRACT_VERSION = "0.1"
REFUSAL_RPC_CODE = -32000

Json = Any

Dialect = Literal["duckdb", "clickhouse"]
ValueType = Literal["string", "integer", "number", "boolean", "date", "timestamp"]
TimeGrain = Literal["day", "week", "month", "quarter", "year"]
Additivity = Literal["additive", "semi_additive", "mergeable", "non_reaggregable"]
DimensionKind = Literal["time", "category", "number", "geo", "entity"]
ModifierOutput = Literal["level", "difference", "ratio", "share", "rank", "rows"]
ChartKind = Literal["line", "area", "bar", "pie", "scatter", "heatmap", "map", "kpi", "table"]
FilterOp = Literal[
    "=", "!=", ">", ">=", "<", "<=",
    "in", "not_in", "between", "is_null", "is_not_null",
    "contains", "starts_with",
]  # fmt: skip
ErrorCode = Literal[
    "unknown_metric", "unknown_dimension", "unknown_modifier",
    "invalid_params", "invalid_composition", "non_additive_violation",
    "filter_op_not_allowed", "result_too_large",
    "timeout_compile", "timeout_execute",
    "upstream_auth_failed", "upstream_unavailable",
    "ns_not_found", "token_invalid", "token_revoked", "rate_limited",
    "provider_error", "internal",
]  # fmt: skip


# ---- query


class Predicate(TypedDict):
    """`value`: scalar; list for `in`, `not_in`, `between`; absent for `is_null`/`is_not_null`."""

    field: str
    op: FilterOp
    value: NotRequired[Json]


class Combinator(TypedDict):
    """`and`/`or` over any number of items; `not` over exactly one."""

    op: Literal["and", "or", "not"]
    items: list["Filter"]


Filter = Combinator | Predicate


class ModifierCall(TypedDict):
    name: str
    params: NotRequired[dict[str, Json]]


class OrderBy(TypedDict):
    """`field` is any output column name, e.g. `delta_pct(revenue)`."""

    field: str
    dir: Literal["asc", "desc"]


class VizHints(TypedDict):
    """Presentation intent; planning and execution ignore it."""

    chart: NotRequired[ChartKind]
    x: NotRequired[str]
    series: NotRequired[str]
    y: NotRequired[list[str]]
    stack: NotRequired[Literal["none", "stacked", "percent"]]
    orientation: NotRequired[Literal["vertical", "horizontal"]]
    title: NotRequired[str]
    echarts: NotRequired[dict[str, Json]]


class SemanticQuery(TypedDict):
    """`modifiers` apply in array order, after metric evaluation, before `order` (MOD-002).

    `params` keys are `param` (every member declaring it) or `member.param`
    (that member only); the more specific wins, then the declared default.
    """

    metrics: list[str]
    dimensions: NotRequired[list[str]]
    filters: NotRequired[Filter]
    modifiers: NotRequired[list[ModifierCall]]
    params: NotRequired[dict[str, Json]]
    order: NotRequired[list[OrderBy]]
    limit: NotRequired[int]
    viz: NotRequired[VizHints]


class EvaluationContext(TypedDict):
    """Fixed per request by the host."""

    evaluation_time: str
    timezone: str


# ---- metadata


class ParamSchema(TypedDict):
    type: Literal["string", "number", "integer", "boolean", "array"]
    enum: NotRequired[list[Json]]
    minimum: NotRequired[float]
    maximum: NotRequired[float]
    items: NotRequired[dict[str, str]]
    default: NotRequired[Json]
    description: NotRequired[str]


class ParamsSchema(TypedDict):
    type: Literal["object"]
    properties: dict[str, ParamSchema]
    required: NotRequired[list[str]]


class MetricDisplay(TypedDict):
    label: NotRequired[str]
    unit: NotRequired[str]
    format: NotRequired[Literal["number", "percent", "currency", "duration"]]
    decimals: NotRequired[int]
    good_when: NotRequired[Literal["up", "down"]]
    color: NotRequired[str]


class DimensionDisplay(TypedDict):
    label: NotRequired[str]
    order: NotRequired[list[Json]]
    colors: NotRequired[dict[str, str]]


class MetricDecl(TypedDict):
    name: str
    description: str
    value_type: ValueType
    additivity: Additivity
    dimensions: list[str]
    params: NotRequired[ParamsSchema]
    display: NotRequired[MetricDisplay]


class DimensionDecl(TypedDict):
    name: str
    description: str
    kind: DimensionKind
    value_type: ValueType
    grains: NotRequired[list[TimeGrain]]
    params: NotRequired[ParamsSchema]
    display: NotRequired[DimensionDisplay]


# `class` is a Python keyword, so the functional form is the only way to name
# the wire field; authors write `{"class": 3, ...}` and the checker agrees.
ModifierDecl = TypedDict(
    "ModifierDecl",
    {
        "name": str,
        "class": Literal[1, 2, 3, 4, 5],
        "params": ParamsSchema,
        "requires": list[Additivity],
        "description": str,
        "origin": Literal["base", "cube"],
        "output": ModifierOutput,
    },
)


class Metadata(TypedDict):
    """Everything a namespace publishes; what is not here does not exist for a query."""

    contract_version: str
    cubes_sha: str
    metrics: list[MetricDecl]
    dimensions: list[DimensionDecl]
    modifiers: list[ModifierDecl]


# ---- result


class Column(TypedDict):
    """`name` is the member's name, or `modifier(metric)` for a modifier output."""

    name: str
    role: Literal["dimension", "metric"]
    member: str
    modifier: NotRequired[str]
    value_type: ValueType
    grain: NotRequired[TimeGrain]


# ---- provider protocol


class InitializeParams(TypedDict):
    contract_version: str


class InitializeResult(TypedDict):
    """Properties of the provider, not of its cubes."""

    contract_version: str
    dialects: list[Dialect]


class PlanParams(TypedDict):
    query: SemanticQuery
    dialect: Dialect
    context: EvaluationContext


class Plan(TypedDict):
    sql: str
    columns: list[Column]  # exactly the columns the SQL returns, in order
    plan: NotRequired[Json]


class ProviderError(TypedDict):
    """`data` of a JSON-RPC refusal."""

    code: ErrorCode
    message: str
    hint: NotRequired[str]


class Refusal(Exception):
    """Raise from `plan` to refuse a query with a closed-taxonomy code."""

    def __init__(self, code: ErrorCode, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def to_error(self) -> ProviderError:
        err: ProviderError = {"code": self.code, "message": self.message}
        if self.hint is not None:
            err["hint"] = self.hint
        return err
