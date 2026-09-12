use std::io::{self, Read};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--compile") {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .expect("Cannot read graph");
        let result = serde_json::from_str::<serde_json::Value>(&input).and_then(|value| {
            let graph = serde_json::from_value(value["graph"].clone())?;
            Ok(
                match grapher::compiler::compile(
                    &graph,
                    value["finalCheck"].as_bool().unwrap_or(true),
                ) {
                    Ok(plan) => serde_json::json!({ "plan": plan, "diagnostics": [] }),
                    Err(diagnostics) => serde_json::json!({ "diagnostics": diagnostics }),
                },
            )
        });
        println!("{}", result.unwrap_or_else(|error| serde_json::json!({ "diagnostics": [{ "code": "E000", "message": error.to_string() }] })));
        return;
    }
    if let Err(error) = grapher::server::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
