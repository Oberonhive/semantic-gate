//! The `semantic-gate` binary.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use semantic_gate::config::Config;

#[derive(Parser)]
#[command(name = "semantic-gate", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the gate.
    Serve {
        /// Path to the YAML configuration file.
        #[arg(long, value_name = "PATH")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { config } => match Config::load(&config) {
            Ok(config) => match semantic_gate::server::serve(&config).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("semantic-gate: {error}");
                    ExitCode::FAILURE
                }
            },
            // CFG-001: a configuration problem stops startup, naming the file
            // or the key at fault.
            Err(error) => {
                eprintln!("semantic-gate: {error}");
                ExitCode::FAILURE
            }
        },
    }
}
