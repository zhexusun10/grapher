fn main() {
    if std::env::args().nth(1).as_deref() == Some("--compile") {
        // Planner callbacks still use the shipping compiler CLI, not a test implementation.
        let compiler =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/grapher");
        let status = std::process::Command::new(compiler)
            .arg("--compile")
            .status()
            .unwrap();
        std::process::exit(status.code().unwrap_or(1));
    }
    grapher::server::benchmark::main();
}
