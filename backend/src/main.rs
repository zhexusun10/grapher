use std::io::{self, Read};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--grapher-env-tool") {
        let status = match grapher::environment_discovery::tool(std::env::args().skip(2).collect())
        {
            Ok(status) => status,
            Err(error) => {
                eprintln!("Native environment observation refused: {error}");
                1
            }
        };
        std::process::exit(status);
    }

    if std::env::args().nth(1).as_deref() == Some("--build-identity") {
        let revision = env!("GRAPHER_BUILD_COMMIT");
        if env!("GRAPHER_BUILD_DIRTY") == "0" {
            println!("{revision}");
        } else {
            println!("dirty:{revision}");
        }
        return;
    }

    if std::env::args().nth(1).as_deref() == Some("--compile") {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .expect("Cannot read graph");
        let result = serde_json::from_str::<serde_json::Value>(&input).and_then(|value| {
            let graph = serde_json::from_value(value["graph"].clone())?;
            let previous: Option<grapher::model::Graph> = value
                .get("previousGraph")
                .filter(|graph| !graph.is_null())
                .map(|graph| serde_json::from_value(graph.clone()))
                .transpose()?;
            let revision: Option<grapher::runtime::PlannerRevisionContext> = value
                .get("revisionContext")
                .filter(|context| !context.is_null())
                .map(|context| serde_json::from_value(context.clone()))
                .transpose()?;
            // Runtime-state constraint passed by the Planner tool boundary:
            // nodes whose results this run already published cannot be removed.
            let unremovable: Vec<String> = value["unremovableNodes"]
                .as_array()
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|name| name.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Ok(
                match grapher::compiler::compile(
                    &graph,
                    value["finalCheck"].as_bool().unwrap_or(true),
                ) {
                    Ok(mut plan) => {
                        let diagnostics =
                            grapher::compiler::unremovable_node_diagnostics(&graph, &unremovable);
                        if diagnostics.is_empty() {
                            let mut mutation_warnings = previous.as_ref()
                                .map(|before| grapher::compiler::changed_advisories(before, &graph));
                            let mut revision_impact = None;
                            if let Some(revision) = revision {
                                let (updated_tasks, original_tasks) = revision.invalidated_completed_by_task(&graph);
                                let count = updated_tasks.len() + original_tasks.len();
                                if count > 0 {
                                    revision_impact = Some(serde_json::json!({ "rerunCount": count }));
                                    let noun = if count == 1 { "node" } else { "nodes" };
                                    let groups = [
                                        ("Tasks changed; rerun these nodes with their updated tasks", updated_tasks),
                                        ("Graph changes affect these nodes; after their dependencies complete, they will rerun their original tasks using the latest workspace, incorporating workspaces passed down by their dependencies", original_tasks),
                                    ]
                                    .into_iter()
                                    .filter(|(_, nodes)| !nodes.is_empty())
                                    .map(|(reason, nodes)| {
                                        let nodes = nodes.iter()
                                            .map(|id| format!("{id:?}"))
                                            .collect::<Vec<_>>().join("\n- ");
                                        format!("{reason}:\n- {nodes}")
                                    })
                                    .collect::<Vec<_>>().join("\n\n");
                                    let message = format!(
                                        "Current draft will invalidate and rerun {count} completed {noun} since:\n{groups}"
                                    );
                                    plan.warnings.push(format!("W304: {message}"));
                                    if let Some(warnings) = &mut mutation_warnings {
                                        warnings.insert(0, grapher::compiler::Diagnostic {
                                            code: "W304".into(),
                                            message,
                                            dependency_path: None,
                                        });
                                    }
                                }
                            }
                            let mut output = serde_json::json!({ "plan": plan, "diagnostics": [] });
                            if let Some(warnings) = mutation_warnings {
                                output["mutationWarnings"] = serde_json::json!(warnings);
                            }
                            if let Some(impact) = revision_impact {
                                output["revisionImpact"] = impact;
                            }
                            output
                        } else {
                            serde_json::json!({ "diagnostics": diagnostics })
                        }
                    }
                    Err(diagnostics) => serde_json::json!({ "diagnostics": diagnostics }),
                },
            )
        });
        println!("{}", result.unwrap_or_else(|error| serde_json::json!({ "diagnostics": [{ "code": "E000", "message": error.to_string() }] })));
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--cleanup-workspaces") {
        if let Err(error) =
            grapher::maintenance::cleanup_workspaces(std::env::args().skip(2).collect())
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    if let Some(argument) = std::env::args().nth(1) {
        eprintln!("Unknown Grapher argument: {argument}");
        std::process::exit(1);
    }

    if let Err(error) = grapher::server::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
