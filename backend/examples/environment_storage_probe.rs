//! Opt-in, read-only hash throughput probe for owned acceptance artifacts.
use std::{path::PathBuf, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(std::env::args_os().nth(1).ok_or("Artifact path required")?);
    let bytes = std::fs::metadata(&path)?.len();
    let start = Instant::now();
    let oid = git2::Oid::hash_file(git2::ObjectType::Blob, &path)?;
    println!(
        "{}",
        serde_json::json!({"backend":"libgit2-blob", "bytes":bytes, "elapsedMs":start.elapsed().as_millis(), "oid":oid.to_string()})
    );
    Ok(())
}
