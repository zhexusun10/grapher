use super::*;
use super::super::{legacy_normalized_bytes, load, normalization, normalized_bytes, save};
use serde_json::{json, Value};

fn fixture(nested: bool) -> View {
    let extra = json!({
        "attributes": [["user.data", [0, 13, 255]], ["security", [7, 8]]],
        "security": [1, 2, 3], "protected": true, "flags": 32,
        "owner": [1001, 1002], "efs": true
    });
    let file = json!({"kind":"file", "mode":420, "blob":"a".repeat(40), "extra":extra});
    let directory = json!({"kind":"directory", "mode":493, "extra":extra});
    let mut value = json!({
        "schema":5, "source":"fixture/项目", "root_mode":493, "root_extra":extra,
        "entries": {
            "file":file, "alias":file, "index":file, "security":file,
            "nested/security":file, "securitY":file, "directory":directory,
            "pipe":{"kind":"special", "mode":384, "special":"fifo", "device":u64::MAX, "extra":extra},
            "link":{"kind":"link", "target":{"value":"a \"quote\"\n\\路径", "project_absolute":false, "kind":"symbolic_file"}, "extra":extra}
        },
        "hardlinks": {
            "aliases":{"alias":"file", "security":"file", "to-security":"security"},
            "outside":{"file":u64::MAX, "security":3}
        },
        "repositories":{},
        "git_entries":{"":directory, "HEAD":file, "index":file, "nested/index":file, "security":file},
        "git_file":true, "git_file_metadata":[1, extra],
        "git_link":false, "git_link_metadata":[0, extra],
        "git_config":[["core.worktree","{workspace}"], ["security","retained value"]],
        "git_files":{"attributes":["/attributes",true], "excludes":["/excludes",false], "security":["ignored",true]},
        "git_global":[0, 13, 127, 255]
    });
    if nested {
        let child = serde_json::to_value(fixture(false)).unwrap();
        value["repositories"] = json!({"child":child, "security":child});
    }
    serde_json::from_value(value).unwrap()
}

fn check_normalization(view: &View) {
    assert_eq!(normalization::bytes(view).unwrap(), legacy_normalized_bytes(view).unwrap());
}

fn check(left: &View, right: &View) {
    check_normalization(left);
    check_normalization(right);
    let expected = legacy_normalized_bytes(left).unwrap() == legacy_normalized_bytes(right).unwrap();
    assert_eq!(equal(left, right), expected);
    assert_eq!(equal(right, left), expected);
    assert_eq!(left == right, expected);
}

fn scalar_changes(value: &Value, path: &str, changes: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let key = key.replace('~', "~0").replace('/', "~1");
                scalar_changes(value, &format!("{path}/{key}"), changes);
            }
        }
        Value::Array(items) => {
            for (index, value) in items.iter().enumerate() {
                scalar_changes(value, &format!("{path}/{index}"), changes);
            }
        }
        Value::Bool(value) => changes.push((path.into(), json!(!value))),
        Value::String(value) => changes.push((path.into(), json!(format!("{value} changed")))),
        Value::Number(value) => {
            let value = value.as_u64().unwrap();
            changes.push((path.into(), json!(if value == u64::MAX || value == 255 { 0 } else { value + 1 })));
        }
        Value::Null => {}
    }
}

#[test]
fn every_serialized_scalar_matches_legacy_normalized_equality() {
    let original = fixture(true);
    check_normalization(&original);
    let value = serde_json::to_value(&original).unwrap();
    let mut changes = Vec::new();
    scalar_changes(&value, "", &mut changes);
    let mut checked = 0;
    for (path, replacement) in changes {
        let mut changed = value.clone();
        *changed.pointer_mut(&path).unwrap() = replacement;
        // Enum discriminants cannot be arbitrary strings; valid alternative
        // variants and optional/map shapes are exercised separately below.
        if let Ok(other) = serde_json::from_value::<View>(changed) {
            check_normalization(&other);
            let expected = legacy_normalized_bytes(&original).unwrap() == legacy_normalized_bytes(&other).unwrap();
            assert_eq!(equal(&original, &other), expected, "{path}");
            assert_eq!(equal(&other, &original), expected, "reverse {path}");
            assert_eq!(original == other, expected, "View equality at {path}");
            checked += 1;
        }
    }
    assert!(checked > 200, "the fixture must exercise all evidence fields: {checked}");
}

#[test]
fn ignored_keys_optional_fields_and_entry_variants_keep_legacy_equality() {
    let original = fixture(true);
    let value = serde_json::to_value(&original).unwrap();
    for (container, key) in [
        ("/entries", "security"), ("/entries", "index"), ("/entries", "file"),
        ("/git_entries", "security"), ("/git_entries", "index"), ("/git_entries", "nested/index"),
        ("/repositories", "security"), ("/repositories", "child"),
        ("/repositories/child/git_entries", "index"),
        ("/hardlinks/aliases", "security"), ("/hardlinks/aliases", "to-security"),
        ("/hardlinks/outside", "security"), ("/git_files", "security"),
    ] {
        let mut changed = value.clone();
        changed.pointer_mut(container).unwrap().as_object_mut().unwrap().remove(key);
        check(&original, &serde_json::from_value(changed).unwrap());
    }
    for path in ["/git_entries", "/git_file_metadata", "/git_link_metadata", "/root_extra/owner", "/repositories/child/root_extra/owner"] {
        let mut changed = value.clone();
        *changed.pointer_mut(path).unwrap() = Value::Null;
        check(&original, &serde_json::from_value(changed).unwrap());
    }
    for kind in ["symbolic_directory", "junction"] {
        let mut changed = value.clone();
        changed["entries"]["link"]["target"]["kind"] = json!(kind);
        check(&original, &serde_json::from_value(changed).unwrap());
    }
    for variant in ["directory", "link", "pipe"] {
        let mut changed = value.clone();
        changed["entries"]["file"] = value["entries"][variant].clone();
        check(&original, &serde_json::from_value(changed).unwrap());
    }
    let mut empty = fixture(false);
    empty.git_entries = Some(BTreeMap::new());
    let mut ignored = empty.clone();
    let entry = original.entries["file"].clone();
    ignored.git_entries = Some(BTreeMap::from([("index".into(), entry.clone()), ("security".into(), entry)]));
    check(&empty, &ignored);
    assert!(equal(&empty, &ignored));
    empty.git_entries = None;
    check(&empty, &ignored);
    assert!(!equal(&empty, &ignored));
}

#[test]
fn stored_evidence_and_checksum_stay_unchanged() {
    let original = fixture(true);
    check_normalization(&original);
    let checksum = git2::Oid::hash_object(git2::ObjectType::Blob, &normalized_bytes(&original).unwrap())
        .unwrap().to_string();
    // Captured from the pre-optimization serializer, not the new comparator.
    assert_eq!(checksum, "91aefc90e6a3ad6da9df0a64f4bf7ee4260bb1e9");
    let temp = tempfile::tempdir().unwrap();
    save(temp.path(), &original).unwrap();
    assert_eq!(std::fs::read_to_string(temp.path().join("checksum")).unwrap(), checksum);
    assert_eq!(std::fs::read(temp.path().join("view.json")).unwrap(), serde_json::to_vec(&original).unwrap());
    let loaded = load(temp.path()).unwrap();
    let mut portable = original.clone();
    portable.strip_system_managed();
    check(&loaded, &portable);
    assert!(equal(&loaded, &portable));
}

#[test]
fn normalization_matches_legacy_for_generated_nested_views_without_mutating_evidence() {
    // Deterministic shape coverage, independent of the single-scalar fixture:
    // combine optional fields, entry variants, escaped keys and nested maps.
    fn next(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *seed ^ (*seed >> 32)
    }
    const NAMES: &[&str] = &[
        "security", "index", "Security", "nested/security", "nested/index",
        "", "quote\"slash\\", "tab\tand\nnewline", "中文/é", "nul\0value",
    ];
    fn name(seed: &mut u64) -> String {
        NAMES[next(seed) as usize % NAMES.len()].into()
    }
    fn extra(seed: &mut u64) -> Extra {
        let attributes: Vec<_> = (0..next(seed) % 4).map(|_| {
            let key = name(seed);
            let data: Vec<_> = (0..next(seed) % 12).map(|_| next(seed) as u8).collect();
            (key, data)
        }).collect();
        let security: Vec<_> = (0..next(seed) % 24).map(|_| next(seed) as u8).collect();
        let owner = (next(seed) & 1 != 0).then(|| (next(seed) as u32, next(seed) as u32));
        serde_json::from_value(json!({
            "attributes": attributes, "security": security, "owner": owner,
            "protected": next(seed) & 1 != 0, "flags": next(seed) as u32,
            "efs": next(seed) & 1 != 0,
        })).unwrap()
    }
    fn entries(seed: &mut u64) -> BTreeMap<String, Entry> {
        let mut entries = BTreeMap::new();
        for path in NAMES {
            if next(seed) % 3 == 0 { continue; }
            let extra = extra(seed);
            let mode = next(seed) as u32;
            let entry = match next(seed) % 4 {
                0 => Entry::Directory { mode, extra },
                1 => Entry::File { mode, extra, blob: name(seed) },
                2 => Entry::Special { mode, extra, special: name(seed), device: next(seed) },
                _ => Entry::Link {
                    extra,
                    target: Link {
                        value: name(seed), project_absolute: next(seed) & 1 != 0,
                        kind: match next(seed) % 3 {
                            0 => crate::workspace_symlinks::Kind::SymbolicFile,
                            1 => crate::workspace_symlinks::Kind::SymbolicDirectory,
                            _ => crate::workspace_symlinks::Kind::Junction,
                        },
                    },
                },
            };
            entries.insert((*path).into(), entry);
        }
        entries
    }
    fn generated_view(seed: &mut u64, depth: usize) -> View {
        let mut view = fixture(false);
        view.source = name(seed);
        view.root_mode = next(seed) as u32;
        view.root_extra = extra(seed);
        view.entries = entries(seed);
        view.git_entries = (next(seed) % 3 != 0).then(|| entries(seed));
        view.git_file = next(seed) & 1 != 0;
        view.git_link = next(seed) & 1 != 0;
        view.git_file_metadata = (next(seed) & 1 != 0).then(|| (next(seed) as u32, extra(seed)));
        view.git_link_metadata = (next(seed) & 1 != 0).then(|| (next(seed) as u32, extra(seed)));
        view.git_config = (0..next(seed) % 5).map(|_| (name(seed), name(seed))).collect();
        view.git_global = (0..next(seed) % 32).map(|_| next(seed) as u8).collect();
        view.git_files = NAMES.iter().map(|key| ((*key).into(), (name(seed), next(seed) & 1 != 0))).collect();
        let aliases: BTreeMap<_, _> = NAMES.iter().map(|key| (*key, name(seed))).collect();
        let outside: BTreeMap<_, _> = NAMES.iter().map(|key| (*key, next(seed))).collect();
        view.hardlinks = serde_json::from_value(json!({"aliases": aliases, "outside": outside})).unwrap();
        if depth != 0 {
            for key in ["child", "security", "index"] {
                if next(seed) & 1 != 0 { view.repositories.insert(key.into(), generated_view(seed, depth - 1)); }
            }
        }
        view
    }
    let mut seed = 0x5eed_2026_u64;
    for _ in 0..128 {
        let view = generated_view(&mut seed, 2);
        let before = serde_json::to_vec(&view).unwrap();
        let expected = legacy_normalized_bytes(&view).unwrap();
        assert_eq!(normalized_bytes(&view).unwrap(), expected);
        assert_eq!(normalization::bytes(&view).unwrap(), expected);
        assert_eq!(serde_json::to_vec(&view).unwrap(), before);
    }
}

#[test]
#[ignore = "local normalized-JSON allocation benchmark; run with --ignored --nocapture"]
fn view_normalization_benchmark() {
    use std::time::{Duration, Instant};
    fn median(mut samples: Vec<Duration>) -> Duration {
        samples.sort();
        samples[samples.len() / 2]
    }
    for (label, files, git_files, security_bytes) in [
        ("empty_security", 5000, 1000, 0),
        ("ordinary_security", 5000, 1000, 128),
        ("large_security", 1000, 200, 2048),
    ] {
        let mut view = fixture(false);
        let extra: Extra = serde_json::from_value(json!({
            "attributes":[["user.data", [0, 1, 2, 3]]], "security":vec![42u8; security_bytes],
            "protected":false, "flags":0, "owner":null, "efs":false,
        })).unwrap();
        let entry = Entry::File { mode: 420, blob: "a".repeat(40), extra };
        view.entries.clear();
        view.git_entries = Some(BTreeMap::new());
        for i in 0..files {
            view.entries.insert(format!("src/file-{i:05}.rs"), entry.clone());
        }
        for i in 0..git_files {
            view.git_entries.as_mut().unwrap().insert(format!("objects/{i:05}"), entry.clone());
        }
        let expected = legacy_normalized_bytes(&view).unwrap();
        assert_eq!(normalization::bytes(&view).unwrap(), expected);
        let mut legacy = Vec::new();
        let mut projected = Vec::new();
        for round in 0..5 {
            for fast in if round % 2 == 0 { [false, true] } else { [true, false] } {
                let started = Instant::now();
                let bytes = if fast { normalization::bytes(&view) } else { legacy_normalized_bytes(&view) }.unwrap();
                let elapsed = started.elapsed();
                assert_eq!(bytes, expected);
                if fast { projected.push(elapsed); } else { legacy.push(elapsed); }
            }
        }
        println!("normalization {label}: files={files}+{git_files}, security_bytes={security_bytes}, old={:?}, projected={:?}, output_bytes={}",
            median(legacy), median(projected), expected.len());
    }
}

#[test]
#[ignore = "local in-memory view comparison benchmark; run with --ignored --nocapture"]
fn view_equality_benchmark() {
    use std::time::{Duration, Instant};
    let mut left = fixture(false);
    let extra: Extra = serde_json::from_value(json!({
        "attributes":[["user.data", [0, 1, 2, 3]]], "security":vec![42u8; 128],
        "protected":false, "flags":0, "owner":null, "efs":false,
    })).unwrap();
    let entry = Entry::File { mode: 420, blob: "a".repeat(40), extra };
    left.entries.clear();
    left.git_entries = Some(BTreeMap::new());
    for i in 0..5000 {
        left.entries.insert(format!("src/file-{i:05}.rs"), entry.clone());
        if i < 1000 {
            left.git_entries.as_mut().unwrap().insert(format!("objects/{i:05}"), entry.clone());
        }
    }
    let mut right = left.clone();
    for changed in [false, true] {
        if changed {
            right.git_global.push(1); // Late difference: compare the entries first.
        }
        let mut legacy = Duration::ZERO;
        let mut borrowed = Duration::ZERO;
        for iteration in 0..6 {
            for fast in [iteration % 2 == 0, iteration % 2 != 0] {
                let start = Instant::now();
                let matches = if fast {
                    equal(std::hint::black_box(&left), std::hint::black_box(&right))
                } else {
                    legacy_normalized_bytes(&left).unwrap() == legacy_normalized_bytes(&right).unwrap()
                };
                let elapsed = start.elapsed();
                if fast { borrowed += elapsed; } else { legacy += elapsed; }
                assert_eq!(matches, !changed);
            }
        }
        println!("6 comparisons, 5000 project + 1000 Git entries, changed={changed}: JSON={:.2}ms borrowed={:.2}ms",
            legacy.as_secs_f64() * 1000.0, borrowed.as_secs_f64() * 1000.0);
    }
}
