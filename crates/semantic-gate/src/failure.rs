//! One error shape for everything between a request and a response.
//!
//! Providers, connectors and the pipeline all fail in the closed taxonomy
//! (`docs/spec/err.md`); this carries a code, a message and a hint until the
//! surface that needs a `request_id` — REST or pgwire — turns it into an
//! [`Envelope`]. Own module because every other module of the crate produces
//! one, and none of them may depend on another just for the type.

use axum::http::StatusCode;
use semantic_gate_core::{Envelope, ErrorCode};

/// A closed-taxonomy failure that has not yet met its request.
#[derive(Debug, Clone)]
pub struct Failure {
    /// The closed code.
    pub code: ErrorCode,
    /// Human-readable; never carries a credential.
    pub message: String,
    /// What the caller could do instead.
    pub hint: Option<String>,
}

impl Failure {
    /// A failure without a hint.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }

    /// Attach a suggestion.
    #[must_use]
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// The envelope for request `request_id`.
    pub fn envelope(self, request_id: String) -> Envelope {
        Envelope {
            code: self.code,
            message: self.message,
            request_id,
            hint: self.hint,
        }
    }
}

/// The HTTP status of each code (`docs/spec/err.md`).
pub fn status(code: ErrorCode) -> StatusCode {
    use ErrorCode::*;
    match code {
        UnknownMetric | UnknownDimension | UnknownModifier | InvalidParams | InvalidComposition
        | NonAdditiveViolation | FilterOpNotAllowed => StatusCode::BAD_REQUEST,
        NsNotFound => StatusCode::NOT_FOUND,
        ResultTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        TimeoutCompile | TimeoutExecute => StatusCode::GATEWAY_TIMEOUT,
        UpstreamAuthFailed | ProviderError => StatusCode::BAD_GATEWAY,
        UpstreamUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        TokenInvalid | TokenRevoked => StatusCode::UNAUTHORIZED,
        RateLimited => StatusCode::TOO_MANY_REQUESTS,
        Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
