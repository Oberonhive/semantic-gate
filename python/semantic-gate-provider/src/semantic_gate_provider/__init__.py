"""semantic-gate-provider — the free-form Python authoring method (brief §4).

A cube author implements `Provider` — `initialize`, `metadata`, `plan` — and
calls `serve(provider)` from the script the cube manifest names as its
`entrypoint`. The gate spawns that process and speaks JSON-RPC 2.0 over stdio;
it never learns how `plan` builds its SQL: by hand, with Ibis, or by delegating
to another engine. Refuse a query with `raise Refusal(code, message, hint)`.

The types mirror `packages/contract/src/index.ts`, which is normative.
"""

from .contract import (
    CONTRACT_VERSION,
    Column,
    Dialect,
    DimensionDecl,
    ErrorCode,
    EvaluationContext,
    Filter,
    InitializeParams,
    InitializeResult,
    Metadata,
    MetricDecl,
    ModifierCall,
    ModifierDecl,
    ParamsSchema,
    Plan,
    PlanParams,
    ProviderError,
    Refusal,
    SemanticQuery,
)
from .stdio import Provider, serve

__all__ = [
    "CONTRACT_VERSION",
    "Column",
    "Dialect",
    "DimensionDecl",
    "ErrorCode",
    "EvaluationContext",
    "Filter",
    "InitializeParams",
    "InitializeResult",
    "Metadata",
    "MetricDecl",
    "ModifierCall",
    "ModifierDecl",
    "ParamsSchema",
    "Plan",
    "PlanParams",
    "Provider",
    "ProviderError",
    "Refusal",
    "SemanticQuery",
    "serve",
]
