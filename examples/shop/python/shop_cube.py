"""The shop cube, hand-written: metrics, dimensions and DuckDB SQL in plain Python.

The provider protocol is the whole interface — `initialize`, `metadata`, `plan`
— and `plan` builds its SQL however it likes; here, by string assembly over a
closed vocabulary, with every value escaped and every identifier taken from a
whitelist. Modifiers are not declared, so a query naming one is refused.
"""

import hashlib
import json

from semantic_gate_provider import (
    CONTRACT_VERSION,
    Metadata,
    Plan,
    PlanParams,
    Refusal,
    serve,
)

GRAINS = ["month", "quarter", "year"]

METRICS = {
    "revenue": {
        "sql": "sum(revenue)",
        "value_type": "number",
        "description": "Gross order revenue.",
        "display": {"label": "Revenue", "unit": "USD", "format": "currency", "good_when": "up"},
    },
    "orders": {
        "sql": "count(*)",
        "value_type": "integer",
        "description": "Number of orders.",
        "display": {"label": "Orders", "format": "number", "decimals": 0, "good_when": "up"},
    },
    "units": {
        "sql": "sum(quantity)",
        "value_type": "integer",
        "description": "Units sold.",
        "display": {"label": "Units", "format": "number", "decimals": 0},
    },
}

DIMENSIONS = {
    "period": {
        "sql": "CAST(date_trunc('{time_grain}', order_date) AS DATE)",
        "kind": "time",
        "value_type": "date",
        "description": "Order date, truncated to the `time_grain` parameter (default month).",
        "display": {"label": "Period"},
    },
    "region": {
        "sql": "region",
        "kind": "category",
        "value_type": "string",
        "description": "Sales region.",
        "display": {"label": "Region", "order": ["EU", "North America", "APAC", "LATAM"]},
    },
    "category": {
        "sql": "category",
        "kind": "category",
        "value_type": "string",
        "description": "Product category.",
        "display": {"label": "Category"},
    },
}

TIME_GRAIN = {
    "type": "object",
    "properties": {"time_grain": {"type": "string", "enum": GRAINS, "default": "month"}},
}

COMPARISONS = {"=": "=", "!=": "<>", ">": ">", ">=": ">=", "<": "<", "<=": "<="}
FILTER_OPS = ["=", "!=", ">=", "<=", "in", "between"]  # what this cube allows on a dimension


def _metadata() -> Metadata:
    md: Metadata = {
        "contract_version": CONTRACT_VERSION,
        "cubes_sha": "",
        "metrics": [
            {
                "name": n,
                "description": m["description"],
                "value_type": m["value_type"],
                "additivity": "additive",
                "dimensions": list(DIMENSIONS),
                "display": m["display"],
            }
            for n, m in METRICS.items()
        ],
        "dimensions": [
            {
                "name": n,
                "description": d["description"],
                "kind": d["kind"],
                "value_type": d["value_type"],
                **({"grains": GRAINS, "params": TIME_GRAIN} if n == "period" else {}),
                "display": d["display"],
            }
            for n, d in DIMENSIONS.items()
        ],
        "modifiers": [],
    }
    md["cubes_sha"] = hashlib.sha256(json.dumps(md, sort_keys=True).encode()).hexdigest()
    return md


def _lit(v: object) -> str:
    if isinstance(v, bool) or v is None:
        raise Refusal("invalid_params", f"unsupported filter value {v!r}")
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    raise Refusal("invalid_params", f"unsupported filter value {v!r}")


class Shop:
    def initialize(self, params):
        return {"contract_version": CONTRACT_VERSION, "dialects": ["duckdb"]}

    def metadata(self) -> Metadata:
        return _metadata()

    def plan(self, params: PlanParams) -> Plan:
        q = params["query"]
        metrics = q.get("metrics", [])
        dims = q.get("dimensions", [])
        if not metrics:
            raise Refusal("invalid_params", "a query names at least one metric")
        for m in metrics:
            if m not in METRICS:
                raise Refusal("unknown_metric", f"unknown metric {m!r}", f"metrics: {', '.join(METRICS)}")
        for d in dims:
            if d not in DIMENSIONS:
                raise Refusal("unknown_dimension", f"unknown dimension {d!r}", f"dimensions: {', '.join(DIMENSIONS)}")
        if q.get("modifiers"):
            name = q["modifiers"][0]["name"]
            raise Refusal("unknown_modifier", f"unknown modifier {name!r}", "this cube declares no modifiers")

        grain = "month"
        for key, v in q.get("params", {}).items():
            if key not in ("time_grain", "period.time_grain"):
                raise Refusal("invalid_params", f"unknown parameter {key!r}", "declared: time_grain")
            if v not in GRAINS:
                raise Refusal("invalid_params", f"time_grain must be one of {GRAINS}, got {v!r}")
            grain = v

        def expr(d: str) -> str:
            return DIMENSIONS[d]["sql"].format(time_grain=grain)

        def pred(p: dict) -> str:
            field, op, value = p["field"], p["op"], p.get("value")
            if field in METRICS:
                raise Refusal("filter_op_not_allowed", f"{field!r} is a metric; this cube filters dimensions only")
            if field not in DIMENSIONS:
                raise Refusal("unknown_dimension", f"unknown dimension {field!r}")
            if op not in FILTER_OPS:
                raise Refusal("filter_op_not_allowed", f"operator {op!r} is not allowed on {field!r}", f"allowed: {', '.join(FILTER_OPS)}")
            col = expr(field)
            cast = (lambda s: f"CAST({s} AS DATE)") if field == "period" else (lambda s: s)
            if op == "in":
                return f"{col} IN ({', '.join(cast(_lit(v)) for v in value)})"
            if op == "between":
                return f"{col} BETWEEN {cast(_lit(value[0]))} AND {cast(_lit(value[1]))}"
            return f"{col} {COMPARISONS[op]} {cast(_lit(value))}"

        def tree(f: dict) -> str:
            if f["op"] in ("and", "or"):
                return "(" + f" {f['op'].upper()} ".join(tree(i) for i in f["items"]) + ")"
            if f["op"] == "not":
                return f"(NOT {tree(f['items'][0])})"
            return pred(f)

        select = [f'{expr(d)} AS "{d}"' for d in dims] + [f'{METRICS[m]["sql"]} AS "{m}"' for m in metrics]
        sql = "SELECT " + ", ".join(select) + " FROM orders"
        if "filters" in q:
            sql += " WHERE " + tree(q["filters"])
        if dims:
            sql += " GROUP BY " + ", ".join(str(i + 1) for i in range(len(dims)))
        outputs = dims + metrics
        order = q.get("order") or [{"field": d, "dir": "asc"} for d in dims]
        keys = []
        for o in order:
            if o["field"] not in outputs:
                raise Refusal("unknown_dimension", f"cannot order by {o['field']!r}: not in the result", f"columns: {', '.join(outputs)}")
            keys.append(f'"{o["field"]}" {o["dir"].upper()}')
        if keys:
            sql += " ORDER BY " + ", ".join(keys)
        if "limit" in q:
            sql += f" LIMIT {int(q['limit'])}"

        columns = [
            {
                "name": d,
                "role": "dimension",
                "member": d,
                "value_type": DIMENSIONS[d]["value_type"],
                **({"grain": grain} if d == "period" else {}),
            }
            for d in dims
        ] + [
            {"name": m, "role": "metric", "member": m, "value_type": METRICS[m]["value_type"]}
            for m in metrics
        ]
        return {"sql": sql, "columns": columns}


if __name__ == "__main__":
    serve(Shop())
