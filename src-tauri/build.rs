fn decode_base64_std(input: &str) -> Result<Vec<u8>, &'static str> {
    let compact: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if compact.is_empty() || compact.len() % 4 != 0 {
        return Err("invalid base64 length");
    }
    let mut out = Vec::with_capacity((compact.len() / 4) * 3);
    for chunk in compact.chunks_exact(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            vals[i] = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if i >= 2 => {
                    pad += 1;
                    0
                }
                _ => return Err("invalid base64 character"),
            };
        }
        if pad == 1 && chunk[3] != b'=' {
            return Err("invalid base64 padding");
        }
        if pad == 2 && (chunk[2] != b'=' || chunk[3] != b'=') {
            return Err("invalid base64 padding");
        }
        let n = ((vals[0] as u32) << 18)
            | ((vals[1] as u32) << 12)
            | ((vals[2] as u32) << 6)
            | (vals[3] as u32);
        out.push(((n >> 16) & 0xff) as u8);
        if pad < 2 {
            out.push(((n >> 8) & 0xff) as u8);
        }
        if pad < 1 {
            out.push((n & 0xff) as u8);
        }
    }
    Ok(out)
}

fn contains_secret_key_marker(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    lowered.contains("private key")
        || lowered.contains("secret key")
        || lowered.contains("encrypted secret")
}

fn validate_optional_updater_pubkey(raw: &str, source: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    if contains_secret_key_marker(trimmed) {
        panic!(
            "Refusing to compile desktop binary: {source} contains private/secret key material instead of a minisign public key."
        );
    }
    if trimmed.starts_with("untrusted comment:") {
        panic!(
            "Refusing to compile desktop binary: {source} appears to be raw 2-line minisign text; Tauri requires the base64-encoded public key string."
        );
    }
    let decoded_bytes = decode_base64_std(trimmed).unwrap_or_else(|reason| {
        panic!(
            "Refusing to compile desktop binary: {source} is not valid base64-encoded minisign public key data ({reason})."
        )
    });
    let decoded = String::from_utf8(decoded_bytes).unwrap_or_else(|_| {
        panic!(
            "Refusing to compile desktop binary: {source} did not decode to UTF-8 minisign public key text."
        )
    });
    if contains_secret_key_marker(&decoded) {
        panic!(
            "Refusing to compile desktop binary: {source} decodes to private/secret key material. Never pass TAURI_SIGNING_PRIVATE_KEY as a public key."
        );
    }
    let lines: Vec<&str> = decoded
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment:") {
        panic!(
            "Refusing to compile desktop binary: {source} does not decode to a valid 2-line minisign public key."
        );
    }
    let key_bytes = decode_base64_std(lines[1]).unwrap_or_else(|reason| {
        panic!(
            "Refusing to compile desktop binary: {source} has an invalid base64 key line ({reason})."
        )
    });
    if key_bytes.len() != 42 || &key_bytes[..2] != b"Ed" {
        panic!(
            "Refusing to compile desktop binary: {source} does not contain a valid 42-byte Ed25519 minisign public key."
        );
    }
}

fn extract_tauri_conf_updater_pubkey(conf_text: &str) -> Option<String> {
    let updater_idx = conf_text.find("\"updater\"")?;
    let tail = &conf_text[updater_idx..];
    let pubkey_key_idx = tail.find("\"pubkey\"")?;
    let after_key = &tail[pubkey_key_idx + "\"pubkey\"".len()..];
    let colon_idx = after_key.find(':')?;
    let after_colon = after_key[colon_idx + 1..].trim_start();
    let after_open = after_colon.strip_prefix('"')?;
    let mut out = String::new();
    let mut escaped = false;
    for ch in after_open.chars() {
        if escaped {
            match ch {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                other => out.push(other),
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(out);
        } else {
            out.push(ch);
        }
    }
    None
}

fn main() {
    // Ensure staged resource directories exist so `cargo check` and `cargo test`
    // succeed before `scripts/desktop-stage.mjs` populates them for packaging.
    for dir in ["resources/runtime", "resources/node"] {
        if let Err(error) = std::fs::create_dir_all(dir) {
            panic!("failed to prepare resource staging directory `{dir}`: {error}");
        }
    }
    println!("cargo:rerun-if-changed=permissions");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=GRAPHER_UPDATER_PUBKEY");
    println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBKEY");

    if let Ok(conf_text) = std::fs::read_to_string("tauri.conf.json") {
        if let Some(pubkey) = extract_tauri_conf_updater_pubkey(&conf_text) {
            validate_optional_updater_pubkey(&pubkey, "plugins.updater.pubkey in tauri.conf.json");
        }
    }
    for var in ["GRAPHER_UPDATER_PUBKEY", "TAURI_UPDATER_PUBKEY"] {
        if let Ok(value) = std::env::var(var) {
            validate_optional_updater_pubkey(&value, var);
        }
    }

    tauri_build::build();
}
