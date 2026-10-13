"""The stdio carrier: JSON-RPC 2.0, one message per line (brief §4).

The gate spawns and supervises the process; this loop only answers. Nothing but
protocol messages may reach stdout — logs go to stderr.
"""

import json
import sys
import traceback
from typing import Any, Protocol

from .contract import (
    REFUSAL_RPC_CODE,
    InitializeParams,
    InitializeResult,
    Metadata,
    Plan,
    PlanParams,
    Refusal,
)

_PARSE_ERROR = -32700
_INVALID_REQUEST = -32600
_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602


class Provider(Protocol):
    """The provider protocol as an interface; `shutdown` belongs to the carrier."""

    def initialize(self, params: InitializeParams) -> InitializeResult:
        """Properties of the provider: contract version and the dialects `plan` can emit."""
        ...

    def metadata(self) -> Metadata:
        """The cube's surface; stable for the life of the process."""
        ...

    def plan(self, params: PlanParams) -> Plan:
        """Compile one query, or raise `Refusal`. Never executes."""
        ...


def _error(id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": err}


def _handle(provider: Provider, line: str) -> tuple[dict[str, Any] | None, bool]:
    """One request line → (response or None for a notification, whether to stop)."""
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return _error(None, _PARSE_ERROR, f"parse error: {e}"), False
    if not isinstance(req, dict) or not isinstance(req.get("method"), str):
        return _error(None, _INVALID_REQUEST, "not a JSON-RPC request"), False
    id = req.get("id")
    method = req["method"]
    params = req.get("params")
    try:
        if method == "initialize":
            result: Any = provider.initialize(params or {})
        elif method == "metadata":
            result = provider.metadata()
        elif method == "plan":
            if not isinstance(params, dict):
                return _error(id, _INVALID_PARAMS, "plan expects params"), False
            result = provider.plan(params)  # type: ignore[arg-type]
        elif method == "shutdown":
            return {"jsonrpc": "2.0", "id": id, "result": None}, True
        else:
            return _error(id, _METHOD_NOT_FOUND, f"unknown method {method!r}"), False
    except Refusal as r:
        return _error(id, REFUSAL_RPC_CODE, r.message, r.to_error()), False
    except Exception as e:  # the gate must get an answer, not a dead pipe
        traceback.print_exc(file=sys.stderr)
        data = {"code": "provider_error", "message": f"{type(e).__name__}: {e}"}
        return _error(id, REFUSAL_RPC_CODE, data["message"], data), False
    return {"jsonrpc": "2.0", "id": id, "result": result}, False


def serve(provider: Provider) -> None:
    """Answer `initialize`, `metadata`, `plan`, `shutdown` until `shutdown` or EOF."""
    for line in sys.stdin:
        if not line.strip():
            continue
        response, stop = _handle(provider, line)
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        if stop:
            return
