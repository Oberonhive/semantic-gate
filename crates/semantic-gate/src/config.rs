//! Configuration loading and validation — capability `CFG` in `docs/spec/cfg.md`.

use std::collections::BTreeMap;
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
    /// Warehouses, by name. Optional: a gate with none serves no namespace.
    #[serde(default)]
    pub datasources: BTreeMap<String, Datasource>,
    /// Published vocabularies, by name; the first path segment of every
    /// semantic request.
    #[serde(default)]
    pub namespaces: BTreeMap<String, Namespace>,
    /// Extra surfaces beyond HTTP.
    #[serde(default)]
    pub listeners: Vec<Listener>,
}

/// Listening addresses (`CFG-002`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listen {
    /// The HTTP address to bind. Required; there is no default that is right
    /// for both host and container deployments.
    pub http: SocketAddr,
}

/// A warehouse the gate executes provider SQL against. Read-only by
/// construction: neither connector can be configured to write (brief §13).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Datasource {
    /// Files or a database file, queried in process.
    Duckdb {
        /// Table name → CSV or Parquet file.
        #[serde(default)]
        tables: BTreeMap<String, PathBuf>,
        /// A DuckDB database file, opened read-only.
        #[serde(default)]
        path: Option<PathBuf>,
    },
    /// A ClickHouse server over its HTTP interface.
    Clickhouse {
        /// Base URL, `http://host:8123`.
        url: String,
        /// Login name.
        #[serde(default = "default_user")]
        user: String,
        /// `env://VAR`; absent means no password.
        #[serde(default)]
        password: Option<Secret>,
    },
}

fn default_user() -> String {
    "default".to_owned()
}

/// A secret, which config may only *reference*: the gate never reads one from
/// a file it could echo or leave on disk (brief §7.4).
#[derive(Clone)]
pub struct Secret(String);

// The variable's name is harmless, but Debug on a config is exactly where a
// future field would leak, so this one never prints anything.
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

impl Secret {
    /// The secret's value from the environment.
    ///
    /// # Errors
    /// If the variable is not set.
    pub fn resolve(&self) -> Result<String, String> {
        std::env::var(&self.0).map_err(|_| format!("environment variable {} is not set", self.0))
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        match text.strip_prefix("env://") {
            Some(var) if !var.is_empty() => Ok(Self(var.to_owned())),
            _ => Err(serde::de::Error::custom(
                "a secret is written env://VARIABLE; it is never stored in the file",
            )),
        }
    }
}

/// One published vocabulary.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Namespace {
    /// A directory holding `cubes.yaml`.
    pub cubes: PathBuf,
    /// The datasource its SQL runs on.
    pub datasource: String,
    /// Row caps.
    #[serde(default)]
    pub limits: Limits,
    /// Browser access.
    #[serde(default)]
    pub cors: Cors,
}

/// Row caps (brief §9.2).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    /// Rows returned when a query names no `limit`; a larger result is refused
    /// rather than truncated.
    #[serde(default = "default_limit")]
    pub default_limit: u64,
    /// The largest `limit` a query may ask for.
    #[serde(default = "max_limit")]
    pub max_limit: u64,
}

fn default_limit() -> u64 {
    1000
}

fn max_limit() -> u64 {
    100_000
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            default_limit: default_limit(),
            max_limit: max_limit(),
        }
    }
}

/// Cross-origin access for pages calling the namespace from a browser.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cors {
    /// Exact origins allowed; none means no CORS headers at all.
    #[serde(default)]
    pub origins: Vec<String>,
}

/// A non-HTTP surface.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Listener {
    /// Semantic SQL over the PostgreSQL wire protocol, bound to one namespace.
    Pgwire {
        /// Address to bind.
        listen: SocketAddr,
        /// The namespace its single table stands for.
        namespace: String,
    },
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
    /// Relative paths resolve against the directory of `path`.
    ///
    /// # Errors
    /// [`ConfigError::Parse`] naming the offending key.
    pub fn from_yaml(source: &str, path: &Path) -> Result<Self, ConfigError> {
        // The key path is the point of the message, so the error is threaded
        // through serde_path_to_error rather than reported at its line number:
        // "listen.http" is actionable, "line 2 column 9" is a puzzle.
        let fail = |message: String| ConfigError::Parse {
            path: path.to_path_buf(),
            message,
        };
        let mut config: Self =
            serde_path_to_error::deserialize(serde_yaml_ng::Deserializer::from_str(source))
                .map_err(|error| {
                    let key = error.path().to_string();
                    let cause = error.into_inner();
                    fail(if key.is_empty() || key == "." {
                        cause.to_string()
                    } else {
                        format!("{key}: {cause}")
                    })
                })?;
        let base = path.parent().unwrap_or(Path::new(""));
        config.resolve_paths(&std::path::absolute(base).unwrap_or_else(|_| base.to_path_buf()));
        config.validate().map_err(fail)?;
        Ok(config)
    }

    /// Paths in a file mean "next to the file", not "where the gate was
    /// started", so one config works from any working directory.
    fn resolve_paths(&mut self, base: &Path) {
        for datasource in self.datasources.values_mut() {
            if let Datasource::Duckdb { tables, path } = datasource {
                tables.values_mut().for_each(|p| *p = base.join(&*p));
                if let Some(p) = path {
                    *p = base.join(&*p);
                }
            }
        }
        for namespace in self.namespaces.values_mut() {
            namespace.cubes = base.join(&namespace.cubes);
        }
    }

    /// Everything that can be refused before a request exists; each message
    /// leads with the key at fault.
    fn validate(&self) -> Result<(), String> {
        for (name, datasource) in &self.datasources {
            match datasource {
                Datasource::Duckdb { tables, path } => {
                    if tables.is_empty() == path.is_none() {
                        return Err(format!(
                            "datasources.{name}: a duckdb datasource has exactly one of `tables` and `path`"
                        ));
                    }
                }
                Datasource::Clickhouse { url, password, .. } => {
                    if !url.starts_with("http://") && !url.starts_with("https://") {
                        return Err(format!("datasources.{name}.url: expected an http(s) URL"));
                    }
                    if let Some(secret) = password {
                        secret
                            .resolve()
                            .map_err(|e| format!("datasources.{name}.password: {e}"))?;
                    }
                }
            }
        }
        for (name, namespace) in &self.namespaces {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(format!(
                    "namespaces.{name}: a name is letters, digits, `-` and `_`"
                ));
            }
            if !self.datasources.contains_key(&namespace.datasource) {
                return Err(format!(
                    "namespaces.{name}.datasource: no datasource named {}",
                    namespace.datasource
                ));
            }
            let Limits {
                default_limit,
                max_limit,
            } = namespace.limits;
            if default_limit == 0 || default_limit > max_limit {
                return Err(format!(
                    "namespaces.{name}.limits: need 0 < default_limit <= max_limit"
                ));
            }
        }
        for (i, listener) in self.listeners.iter().enumerate() {
            let Listener::Pgwire { namespace, .. } = listener;
            if !self.namespaces.contains_key(namespace) {
                return Err(format!(
                    "listeners[{i}].namespace: no namespace named {namespace}"
                ));
            }
        }
        Ok(())
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
