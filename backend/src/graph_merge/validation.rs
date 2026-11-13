use crate::{
    engine::{run_pi, PiRequest},
    process_control,
};
use std::fmt;

// Additional model turns, not new executions. Bound repeated unsuccessful
// repairs without turning provider, storage or cancellation errors into prompts.
const MAX_REPAIR_TURNS: usize = 3;

#[derive(Debug)]
pub(crate) enum ResolutionError {
    Repair(String),
    Fatal(String),
}

impl From<String> for ResolutionError {
    fn from(error: String) -> Self {
        Self::Fatal(error)
    }
}

impl From<&str> for ResolutionError {
    fn from(error: &str) -> Self {
        Self::Fatal(error.into())
    }
}

impl fmt::Display for ResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Repair(error) | Self::Fatal(error) => formatter.write_str(error),
        }
    }
}

pub(super) fn run_validated_merger(
    request: PiRequest<'_>,
    mut output: impl FnMut(String) -> Result<(), String>,
    mut validate: impl FnMut() -> Result<(), ResolutionError>,
) -> Result<(), String> {
    let _operation = process_control::OperationControl::begin()?;
    let mut task = request.task.to_owned();
    for turn in 0..=MAX_REPAIR_TURNS {
        process_control::check_current_owner_stop()?;
        let mut output_error = None;
        let result = run_pi(
            PiRequest {
                role: request.role,
                config: request.config,
                cwd: request.cwd,
                task: &task,
                session_dir: request.session_dir,
                extension: request.extension,
                tools: request.tools,
                session_id: request.session_id,
                extra_args: request.extra_args.clone(),
                environment: request.environment.clone(),
                system_prompt: request.system_prompt,
                images: if turn == 0 { request.images } else { None },
            },
            |text| {
                if let Err(error) = output(text) {
                    output_error.get_or_insert(error);
                }
            },
        );
        if let Some(error) = output_error {
            return Err(format!("Cannot persist merger output: {error}"));
        }
        result?;
        process_control::check_current_owner_stop()?;
        match validate() {
            Ok(()) => {
                process_control::check_current_owner_stop()?;
                return Ok(());
            }
            Err(ResolutionError::Fatal(error)) => return Err(error),
            Err(ResolutionError::Repair(error)) => {
                if turn == MAX_REPAIR_TURNS {
                    return Err(format!(
                        "Merger validation still failed after {MAX_REPAIR_TURNS} repair turns: {error}"
                    ));
                }
                task = format!(
                    "Merge validation failed:\n\n{error}\n\nFix the remaining issue and rerun the Git checks."
                );
                output(format!(
                    "\nMerger validation failed; requesting repair {}/{MAX_REPAIR_TURNS}: {error}\n",
                    turn + 1
                ))
                .map_err(|error| format!("Cannot persist merger output: {error}"))?;
            }
        }
    }
    unreachable!("the final validation either succeeds or returns its error")
}

// Attempt both sinks independently. A failed session-file write must not
// suppress the durable event-log copy (nor hide either persistence error).
pub(super) fn persist_output(
    log: &mut impl std::io::Write,
    text: String,
    emit: impl FnOnce(String) -> Result<(), String>,
) -> Result<(), String> {
    let file = log
        .write_all(text.as_bytes())
        .map_err(|error| error.to_string());
    let event = emit(text);
    match (file, event) {
        (Err(file), Err(event)) => Err(format!("Session log: {file}; event log: {event}")),
        (file, event) => file.and(event),
    }
}

#[cfg(all(test, feature = "fixture"))]
#[path = "validation_tests.rs"]
mod tests;
