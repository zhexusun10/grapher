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
                            if let Some(revision) = revision {
                                let affected = revision.invalidated_completed(&graph);
                                if !affected.is_empty() {
                                    let noun = if affected.len() == 1 { "node" } else { "nodes" };
                                    plan.warnings.push(format!(
                                        "W304: Current changes will invalidate and rerun {} completed {noun}: {}.",
                                        affected.len(), affected.join(", ")
                                    ));
                                }
                            }
                            serde_json::json!({ "plan": plan, "diagnostics": [] })
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
    if std::env::args().nth(1).as_deref() == Some("--repair-publication-file") {
        if let Err(error) = grapher::maintenance::repair_publication_file(std::env::args().skip(2).collect()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--restore-paused-batch") {
        if let Err(error) = grapher::maintenance::restore_paused_batch(std::env::args().skip(2).collect()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
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
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some("--compact" | "--migrate")
    ) {
        if let Err(error) = grapher::server::compact_output_chunks() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    if let Err(error) = grapher::server::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
