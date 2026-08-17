//! Configuration loading and validation — capability `CFG` in `docs/spec/cfg.md`.

use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The whole of the gate's configuration (`CFG-001`).
///
/// Unknown keys are rejected rather than ignored: a typo that is silently
/// dropped is a setting the operator believes is in effect and is not.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Where the gate listens.
    pub listen: Listen,
}

/// Listening addresses (`CFG-002`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listen {
    /// The HTTP address to bind. Required; there is no default that is right
    /// for both host and container deployments.
    pub http: SocketAddr,
}

/// Why a configuration could not be used.
///
/// Every variant names the file or the key at fault, because "invalid
/// configuration" is not something an operator can act on.
#[derive(Debug)]
pub enum ConfigError {
    /// The file could not be read.
    Read {
        /// The path that was tried.
        path: PathBuf,
        /// What the filesystem said.
        source: std::io::Error,
    },
    /// The file could be read but not understood.
    Parse {
        /// The path that was tried.
        path: PathBuf,
        /// What was wrong, naming the offending key.
        message: String,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Parse { path, message } => write!(f, "{}: {message}", path.display()),
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Parse a configuration from YAML source (`CFG-001`, `CFG-002`).
    ///
    /// # Errors
    /// [`ConfigError::Parse`] naming the offending key.
    pub fn from_yaml(source: &str, path: &Path) -> Result<Self, ConfigError> {
        // The key path is the point of the message, so the error is threaded
        // through serde_path_to_error rather than reported at its line number:
        // "listen.http" is actionable, "line 2 column 9" is a puzzle.
        serde_path_to_error::deserialize(serde_yaml_ng::Deserializer::from_str(source)).map_err(
            |error| {
                let key = error.path().to_string();
                let cause = error.into_inner();
                ConfigError::Parse {
                    path: path.to_path_buf(),
                    message: if key.is_empty() || key == "." {
                        cause.to_string()
                    } else {
                        format!("{key}: {cause}")
                    },
                }
            },
        )
    }

    /// Read and parse a configuration file (`CFG-001`).
    ///
    /// # Errors
    /// [`ConfigError::Read`] naming the path, or [`ConfigError::Parse`] naming
    /// the offending key.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let source = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_yaml(&source, path)
    }
}
