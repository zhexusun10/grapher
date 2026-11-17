//! Observable post-agent work. Result validation remains a completion barrier;
//! activity and transcript timings explain the work while that barrier drains.
use std::time::Instant;

pub(super) struct NodeCompletion<'a, F: FnMut(String)> {
    activity: crate::server::RuntimeActivityGuard,
    output: &'a mut F,
}

impl<'a, F: FnMut(String)> NodeCompletion<'a, F> {
    pub(super) fn new(run: &str, execution: &str, node: &str, output: &'a mut F) -> Self {
        Self {
            activity: crate::server::RuntimeActivityGuard::begin(
                run,
                &format!("finalize-{execution}"),
                "node_finalize",
                node,
            ),
            output,
        }
    }

    pub(super) fn run<T>(
        &mut self,
        phase: &str,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.activity.phase(phase);
        (self.output)(format!(
            "{}\n",
            serde_json::json!({
                "type": "grapher_completion_phase", "phase": phase,
                "status": "running", "timestamp": crate::model::now(),
            })
        ));
        let started = Instant::now();
        let result = work();
        (self.output)(format!(
            "{}\n",
            serde_json::json!({
                "type": "grapher_completion_phase", "phase": phase,
                "status": if result.is_ok() { "completed" } else { "failed" },
                "elapsedMs": started.elapsed().as_millis(), "timestamp": crate::model::now(),
            })
        ));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_timings_retain_success_and_failure_without_changing_results() {
        let mut output = Vec::new();
        {
            let mut emit = |text| output.push(text);
            let mut completion = NodeCompletion::new("timing-run", "attempt", "node", &mut emit);
            assert_eq!(completion.run("snapshot", || Ok(42)), Ok(42));
            assert_eq!(
                completion.run::<()>("environment", || Err("seal failed".into())),
                Err("seal failed".into()),
            );
        }
        let events: Vec<serde_json::Value> = output
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0]["phase"], "snapshot");
        assert_eq!(events[0]["status"], "running");
        assert_eq!(events[1]["status"], "completed");
        assert!(events[1]["elapsedMs"].is_u64());
        assert_eq!(events[2]["phase"], "environment");
        assert_eq!(events[3]["status"], "failed");
        assert!(events[3]["elapsedMs"].is_u64());
    }
}
