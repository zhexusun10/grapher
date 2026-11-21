fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/services/apiContract.generated.ts");
    let content = grapher::api_contract::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            content,
            "Browser API bindings are stale; run npm run api:generate"
        );
    } else {
        std::fs::write(path, content).unwrap();
    }
}
