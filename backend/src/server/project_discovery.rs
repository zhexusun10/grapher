use super::Service;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_SKILL_PREVIEW_BYTES: u64 = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillItem {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) path: String,
    pub(super) scope: String,
}

pub(super) fn parse_skill_markdown(path: &Path) -> Option<(String, String)> {
    // Skill paths may be user-provided links, but pipes/devices are not documents.
    // In particular, opening a FIFO for reading can wait forever for a writer.
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    // Discovery previews metadata; it must not allocate the whole instruction body.
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_SKILL_PREVIEW_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let content = match std::str::from_utf8(&bytes) {
        Ok(content) => content,
        // A bounded preview can end inside a valid UTF-8 code point.
        Err(error)
            if bytes.len() as u64 == MAX_SKILL_PREVIEW_BYTES && error.error_len().is_none() =>
        {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    let mut name = None;
    let mut description = None;

    if let Some(after_start) = content.strip_prefix("---") {
        let mut offset = 0;
        let end_idx = after_start.split_inclusive('\n').find_map(|line| {
            let start = offset;
            offset += line.len();
            // Delimiters occupy an unindented line. Quoted text and indented
            // description blocks may contain literal runs of three dashes.
            (line.trim_end() == "---").then_some(start)
        });
        if let Some(end_idx) = end_idx {
            let frontmatter = &after_start[..end_idx];
            let mut in_desc_block = false;
            let mut desc_lines = Vec::new();

            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("name:") {
                    in_desc_block = false;
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if !val.is_empty() {
                        name = Some(val.to_string());
                    }
                } else if let Some(rest) = trimmed.strip_prefix("description:") {
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if val.is_empty() || val == ">-" || val == "|" || val == ">" {
                        in_desc_block = true;
                    } else {
                        in_desc_block = false;
                        description = Some(val.to_string());
                    }
                } else if in_desc_block {
                    if line.starts_with("  ") || line.starts_with('\t') {
                        let t = line.trim();
                        if !t.is_empty() {
                            desc_lines.push(t);
                        }
                    } else if !trimmed.is_empty() {
                        in_desc_block = false;
                    }
                }
            }

            if description.is_none() && !desc_lines.is_empty() {
                description = Some(desc_lines.join(" "));
            }
        }
    }

    let skill_name = name.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string())
    });

    let skill_desc = description.unwrap_or_else(|| {
        content
            .lines()
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#') && !t.starts_with("---")
            })
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    });

    Some((skill_name, skill_desc))
}

fn git_probe_command(git: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(git);
    crate::native::clear_git_environment(&mut command);
    command.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

pub(super) fn resolve_repo_path(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> PathBuf {
    if let Some(repo) = repository_param.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(repo);
    }
    if let Ok(runtime) = service.runtime.lock() {
        if let Some(config) = &runtime.state.config {
            if !config.repository.trim().is_empty() {
                return PathBuf::from(&config.repository);
            }
        }
    }
    if let Ok(Some(repo)) = crate::workspace::detect(None) {
        return PathBuf::from(repo.path);
    }
    // 当进程在子目录（如 backend/）执行时，通过 git rev-parse 向上查找仓库根目录
    if let Ok(git) = crate::native::trusted_git() {
        if let Ok(output) = git_probe_command(&git)
            .arg("rev-parse")
            .arg("--show-toplevel")
            .output()
        {
            if output.status.success() {
                let toplevel = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !toplevel.is_empty() {
                    return PathBuf::from(toplevel);
                }
            }
        }
    }
    let installation = crate::native::installation_root();
    if installation.exists() {
        return installation;
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub(super) fn is_excluded_project_path(rel_path: &str) -> bool {
    let lower = rel_path.to_lowercase();
    // 排除技能目录、内部框架目录、版本控制和编译产物，不把 skill 规则文档当做项目文件
    if lower.starts_with(".agents/")
        || lower == ".agents"
        || lower.starts_with(".pi/")
        || lower == ".pi"
        || lower.starts_with(".git/")
        || lower == ".git"
        || lower.starts_with(".grapher/")
        || lower == ".grapher"
        || lower.starts_with(".gemini/")
        || lower == ".gemini"
        || lower.starts_with(".codex/")
        || lower == ".codex"
        || lower.starts_with("node_modules/")
        || lower == "node_modules"
        || lower.starts_with("target/")
        || lower == "target"
        || lower.starts_with("dist/")
        || lower == "dist"
        || lower.starts_with("build/")
        || lower == "build"
        || lower.starts_with(".next/")
        || lower == ".next"
        || lower.ends_with(".ds_store")
    {
        return true;
    }
    // 排除任何以点开头的隐藏目录（如 .cache/, .husky/ 等），保留根目录常规点文件（如 .gitignore, .env.example）
    for (idx, part) in rel_path.split('/').enumerate() {
        if part.starts_with('.') {
            let is_root_file = idx == 0 && !rel_path.contains('/');
            let is_allowed_dotfile =
                part == ".gitignore" || part == ".gitmodules" || part.starts_with(".env");
            if !(is_root_file && is_allowed_dotfile) {
                return true;
            }
        }
    }
    false
}

pub(super) fn collect_files_from_dir(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let is_git = dir.join(".git").exists() || crate::workspace::is_standard_git(dir);
    if is_git {
        if let Ok(git) = crate::native::trusted_git() {
            let mut command = git_probe_command(&git);
            #[cfg(target_os = "macos")]
            command.args(["-c", "core.precomposeunicode=false"]);
            if let Ok(output) = command
                .arg("ls-files")
                .arg("-z")
                .arg("--cached")
                .arg("--others")
                .arg("--exclude-standard")
                .current_dir(dir)
                .output()
            {
                if output.status.success() {
                    for entry in output.stdout.split(|byte| *byte == 0) {
                        let Ok(path) = std::str::from_utf8(entry) else {
                            continue;
                        };
                        if !path.is_empty() && !is_excluded_project_path(path) {
                            files.push(path.to_string());
                        }
                    }
                }
            }
        }
    }

    if files.is_empty() {
        fn walk(
            walk_dir: &Path,
            base: &Path,
            files: &mut Vec<String>,
            limit: usize,
            ancestors: &mut HashSet<String>,
        ) {
            if files.len() >= limit {
                return;
            }
            let identity = crate::path_identity::path_key(walk_dir);
            if !ancestors.insert(identity.clone()) {
                return;
            }
            if let Ok(entries) = fs::read_dir(walk_dir) {
                for entry in entries.flatten() {
                    if files.len() >= limit {
                        break;
                    }
                    let path = entry.path();
                    if let Ok(rel) = path.strip_prefix(base) {
                        let rel_str = rel.to_string_lossy().replace('\\', "/");
                        if is_excluded_project_path(&rel_str) {
                            continue;
                        }
                    }
                    if path.is_dir() {
                        walk(&path, base, files, limit, ancestors);
                    } else if path.is_file() {
                        if let Ok(rel) = path.strip_prefix(base) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if !is_excluded_project_path(&rel_str) {
                                files.push(rel_str);
                            }
                        }
                    }
                }
            }
            // Track only this branch, not every visited directory: two
            // noncyclic aliases must both remain available as project paths.
            ancestors.remove(&identity);
        }
        walk(dir, dir, &mut files, 3000, &mut HashSet::new());
    }
    files
}

pub(super) fn list_files(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let mut files = if repo_path.exists() {
        collect_files_from_dir(&repo_path)
    } else {
        Vec::new()
    };

    files.sort();
    Ok(serde_json::json!({ "files": files }))
}

pub(super) fn list_skills(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let home_dir = crate::native::home_dir();
    let mut search_dirs: Vec<(PathBuf, &'static str)> = Vec::new();

    // 1. Pi 工作区技能规范 (Project Skills: .agents/skills, .pi/skills, skills)
    search_dirs.push((repo_path.join(".agents").join("skills"), "workspace"));
    search_dirs.push((repo_path.join(".pi").join("skills"), "workspace"));
    search_dirs.push((repo_path.join("skills"), "workspace"));

    // 2. Grapher 宿主内置技能规范 (Grapher Host App: .agents/skills, .pi/skills, skills)
    {
        let grapher_root = crate::native::installation_root();
        if !crate::path_identity::same_path(&grapher_root, &repo_path) {
            search_dirs.push((grapher_root.join(".agents").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join(".pi").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join("skills"), "builtin"));
        }
    }

    // 3. Pi 全局用户技能规范 (User Skills: agent_dir/skills, ~/.pi/agent/skills, ~/.agents/skills, ~/.pi/skills)
    if let Ok(agent_dir) = crate::native::agent_dir() {
        search_dirs.push((agent_dir.join("skills"), "global"));
    }
    if let Some(ref home) = home_dir {
        search_dirs.push((
            home.join(".grapher").join("pi-agent").join("skills"),
            "global",
        ));
        search_dirs.push((home.join(".pi").join("agent").join("skills"), "global"));
        search_dirs.push((home.join(".agents").join("skills"), "global"));
        search_dirs.push((home.join(".pi").join("skills"), "global"));
    }

    let mut skills = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    fn scan_skills_dir(
        dir: &Path,
        scope: &str,
        skills: &mut Vec<SkillItem>,
        seen_names: &mut std::collections::HashSet<String>,
        ancestors: &mut HashSet<String>,
    ) {
        if !dir.exists() || !dir.is_dir() {
            return;
        }
        let identity = crate::path_identity::path_key(dir);
        if !ancestors.insert(identity.clone()) {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some((name, desc)) = parse_skill_markdown(&skill_md) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: skill_md.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    } else {
                        // 深入子分组目录扫描
                        scan_skills_dir(&path, scope, skills, seen_names, ancestors);
                    }
                } else if path.is_file() {
                    // Pi 规范：~/.pi/agent/skills 与 ~/.pi/skills 支持直接根级单文件技能
                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.ends_with(".md")
                        && file_name != "README.md"
                        && file_name != "AGENTS.md"
                    {
                        if let Some((name, desc)) = parse_skill_markdown(&path) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: path.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
        ancestors.remove(&identity);
    }

    for (dir, scope) in &search_dirs {
        scan_skills_dir(
            dir,
            scope,
            &mut skills,
            &mut seen_names,
            &mut HashSet::new(),
        );
    }

    skills.sort_by(|a, b| {
        let scope_order = |s: &str| match s {
            "workspace" => 0,
            "builtin" => 1,
            "global" => 2,
            _ => 3,
        };
        scope_order(&a.scope)
            .cmp(&scope_order(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(serde_json::json!({ "skills": skills }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_metadata_only_closes_frontmatter_on_an_unindented_delimiter_line() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("SKILL.md");
        for (document, name, description) in [
            (
                "---\ndescription: 'Handle --- tokens'\nname: inline-dash\n---\nBody",
                "inline-dash",
                "Handle --- tokens",
            ),
            (
                "---\nname: block-dash\ndescription: |\n  Handle\n  ---\n  tokens\n---\nBody",
                "block-dash",
                "Handle --- tokens",
            ),
        ] {
            for newline in ["\n", "\r\n"] {
                fs::write(&path, document.replace('\n', newline)).unwrap();
                assert_eq!(
                    parse_skill_markdown(&path),
                    Some((name.into(), description.into()))
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn skill_discovery_reads_large_document_metadata_under_a_memory_limit() {
        const FIXTURE_PATH: &str = "GRAPHER_TEST_LARGE_SKILL_PATH";
        if let Some(path) = std::env::var_os(FIXTURE_PATH) {
            let mut original = std::mem::MaybeUninit::<libc::rlimit>::uninit();
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_AS, original.as_mut_ptr()) },
                0
            );
            let original = unsafe { original.assume_init() };
            let limit = libc::rlimit {
                rlim_cur: original.rlim_max.min(512 * 1024 * 1024),
                rlim_max: original.rlim_max,
            };
            let no_core = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_CORE, &no_core) }, 0);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_AS, &limit) }, 0);
            assert_eq!(
                parse_skill_markdown(Path::new(&path)),
                Some(("bounded-skill".into(), "large body".into()))
            );
            return;
        }
        // A sparse body costs no large allocation or disk write in the fixture.
        // Run the parser separately so its memory limit cannot affect other tests.
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("SKILL.md");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"---\nname: bounded-skill\ndescription: large body\n---\n")
            .unwrap();
        file.set_len(2 * 1024 * 1024 * 1024).unwrap();
        drop(file);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "server::project_discovery::tests::skill_discovery_reads_large_document_metadata_under_a_memory_limit",
            ])
            .env(FIXTURE_PATH, &path)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "metadata discovery exhausted its memory limit"
        );
    }

    #[test]
    fn skill_metadata_survives_a_multibyte_character_at_the_preview_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("SKILL.md");
        let header = b"---\nname: bounded-skill\ndescription: large body\n---\n";
        let mut bytes = header.to_vec();
        bytes.resize(64 * 1024 - 1, b'x');
        bytes.extend_from_slice("界".as_bytes());
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            parse_skill_markdown(&path),
            Some(("bounded-skill".into(), "large body".into()))
        );
        for invalid_suffix in [0xff, 0xe7] {
            let mut invalid = header.to_vec();
            invalid.push(invalid_suffix);
            fs::write(&path, invalid).unwrap();
            assert!(
                parse_skill_markdown(&path).is_none(),
                "invalid UTF-8 inside a short document remains invalid"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn skill_discovery_does_not_read_named_pipes() {
        use std::{
            os::unix::ffi::OsStrExt,
            process::Command,
            time::{Duration, Instant},
        };

        const FIXTURE_PATH: &str = "GRAPHER_TEST_SKILL_FIFO";
        if let Some(path) = std::env::var_os(FIXTURE_PATH) {
            assert!(parse_skill_markdown(Path::new(&path)).is_none());
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("SKILL.md");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        // Isolate the blocking-open regression so a failure cannot hang the suite.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "server::project_discovery::tests::skill_discovery_does_not_read_named_pipes",
            ])
            .env(FIXTURE_PATH, &path)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "skill parser failed on a non-regular file");
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("skill discovery blocked on a named pipe");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn file_discovery_skips_ancestor_links_without_hiding_noncyclic_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let external = temp.path().join("external");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(root.join("main.txt"), "project").unwrap();
        fs::write(external.join("shared.txt"), "linked input").unwrap();
        crate::path_safety::directory_link(&root, &root.join("back"));
        crate::path_safety::directory_link(&external, &root.join("dependency"));
        crate::path_safety::directory_link(&external, &root.join("alias"));
        let mut files = collect_files_from_dir(&root);
        files.sort();
        assert_eq!(
            files,
            ["alias/shared.txt", "dependency/shared.txt", "main.txt"]
        );
        for link in ["back", "dependency", "alias"] {
            crate::path_safety::remove_directory_link(&root.join(link));
        }
    }

    #[test]
    fn skill_discovery_avoids_cycles_and_keeps_linked_skill_directories() {
        use crate::runtime::Runtime;
        use std::sync::{atomic::AtomicBool, Condvar, Mutex};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let skills = root.join(".agents/skills");
        let group = skills.join("group");
        fs::create_dir_all(group.join("task")).unwrap();
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        let group_name = uuid::Uuid::new_v4().to_string();
        let linked_name = uuid::Uuid::new_v4().to_string();
        for (directory, name) in [
            (&group.join("task"), &group_name),
            (&external, &linked_name),
        ] {
            fs::write(
                directory.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: linked fixture\n---\n"),
            )
            .unwrap();
        }
        crate::path_safety::directory_link(&group, &group.join("back"));
        crate::path_safety::directory_link(&external, &skills.join("linked"));
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open_lazy(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: PathBuf::new(),
        });
        let result = list_skills(&service, Some(root.to_string_lossy().into_owned())).unwrap();
        let entries = result["skills"].as_array().unwrap();
        for (name, path) in [
            (&group_name, group.join("task/SKILL.md")),
            (&linked_name, skills.join("linked/SKILL.md")),
        ] {
            let matched: Vec<_> = entries
                .iter()
                .filter(|entry| entry["name"] == *name)
                .collect();
            assert_eq!(matched.len(), 1);
            assert_eq!(matched[0]["scope"], "workspace");
            assert_eq!(
                Path::new(matched[0]["path"].as_str().unwrap()),
                path.as_path()
            );
        }
        crate::path_safety::remove_directory_link(&group.join("back"));
        crate::path_safety::remove_directory_link(&skills.join("linked"));
    }
}
