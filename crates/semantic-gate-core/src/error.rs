//! The closed error taxonomy and its envelope (`docs/spec/err.md`, brief
//! §3.4).

use serde::Serialize;

/// One of the eighteen error codes the gate ever returns (`docs/spec/err.md`
/// §3.4). Closed by construction: there is no variant for "anything else",
/// so an out-of-vocabulary code cannot be built — the guarantee is the
/// compiler's, not a test's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// A requested metric is not in the namespace's declared vocabulary.
    UnknownMetric,
    /// A requested dimension is not in the namespace's declared vocabulary.
    UnknownDimension,
    /// A requested modifier is not in the namespace's declared vocabulary.
    UnknownModifier,
    /// A modifier's parameters do not match its declared schema.
    InvalidParams,
    /// The requested modifiers cannot compose (order, universe, or class
    /// rules).
    InvalidComposition,
    /// A non-additive metric was combined with a modifier that would produce
    /// a silently wrong aggregate.
    NonAdditiveViolation,
    /// A filter operator is not allowed for the field it targets.
    FilterOpNotAllowed,
    /// The result would exceed the namespace's row limit.
    ResultTooLarge,
    /// The provider's `plan` call did not return in time.
    TimeoutCompile,
    /// Query execution against the datasource did not return in time.
    TimeoutExecute,
    /// The datasource rejected the resolved credentials.
    UpstreamAuthFailed,
    /// The datasource could not be reached.
    UpstreamUnavailable,
    /// No namespace exists under the requested name.
    NsNotFound,
    /// The caller's gate token does not exist or is malformed.
    TokenInvalid,
    /// The caller's gate token has been revoked.
    TokenRevoked,
    /// The caller exceeded a rate limit.
    RateLimited,
    /// The cube provider returned an error outside the closed taxonomy.
    ProviderError,
    /// An unexpected failure with no closed-taxonomy code of its own; never
    /// provoked artificially (`docs/spec/err.md`).
    Internal,
}

/// The envelope every non-2xx response from the semantic surface carries
/// (`docs/spec/err.md`, `ERR-001`).
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    /// The closed error code.
    pub code: ErrorCode,
    /// Human-readable; never echoes a submitted credential or upstream
    /// database detail.
    pub message: String,
    /// Assigned by the gate to every request; the cross-stream join key with
    /// the service log and the audit stream (brief §9.1, §10).
    pub request_id: String,
    /// Present only when the gate has something concrete to suggest to the
    /// caller; the key is absent — not `null` — otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}
