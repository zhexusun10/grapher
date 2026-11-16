//! Metadata-only eligibility, followed by ordinary full-byte validation and
//! independent materialization on the native worker. Never read a live parent.
use super::*;

impl Files {
    pub(crate) fn home_target_is_empty(&self, workspace: &Path) -> Result<bool, String> {
        let root = workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut entries = Entries::new();
        let untouched = RefCell::default();
        for path in self.scoped_paths(&root)? {
            self.collect(&root, &path, &mut entries, Collection::Inspect(&untouched))?;
        }
        let untouched = untouched.into_inner();
        Ok(entries
            .values()
            .all(|entry| matches!(entry, Entry::Directory { .. }))
            && untouched.iter().all(|name| self.is_cache(Path::new(name))))
    }

    pub(crate) fn home_only_snapshot(&self, version: &str, home: &str) -> Result<bool, String> {
        relative(home)?;
        let value = self.load(version)?;
        let Some(snapshot) = value.rooted else {
            return Ok(false);
        };
        let Some(root) = snapshot.roots.get("state") else {
            return Ok(false);
        };
        if snapshot.roots.len() != 1 || !root.layout.covers(home) {
            return Ok(false);
        }
        let in_home = |path: &str| workspace::scope_contains(Path::new(path), Path::new(home));
        for (name, entry) in &root.entries {
            match entry {
                // Empty directories in the default scopes contain no installed
                // environment bytes. A file/link outside HOME is not eligible.
                Entry::Directory { .. } => {}
                Entry::File { .. } if in_home(name) => {}
                Entry::Link {
                    target,
                    internal: true,
                    ..
                } if in_home(name) && in_home(target) && root.entries.contains_key(target) => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_home_fork_metadata_never_authorizes_external_links_or_another_root() {
        let temp = tempfile::tempdir().unwrap();
        let files = Files::environment(temp.path(), &[], &[]).unwrap();
        let entries = Entries::from([
            ("home".into(), Entry::Directory { mode: 0 }),
            (
                "home/input".into(),
                Entry::File {
                    blob: "0".repeat(40),
                    mode: 0,
                },
            ),
            ("elsewhere".into(), Entry::Directory { mode: 0 }),
        ]);
        let root = rooted::Root {
            layout: RootScope::normalized(vec!["home".into(), "elsewhere".into()], vec![]),
            entries,
        };
        for (target, internal, expected) in [
            ("home/input", true, true),
            ("elsewhere", true, false),
            ("external-input", false, false),
        ] {
            let mut state = root.clone();
            state.entries.insert(
                "home/link".into(),
                Entry::Link {
                    target: target.into(),
                    internal,
                    directory: false,
                },
            );
            let version = Uuid::new_v4().to_string();
            files
                .save_version(
                    &version,
                    Version {
                        head: String::new(),
                        parents: vec![],
                        entries: Entries::new(),
                        checksum: None,
                        rooted: Some(rooted::Snapshot {
                            schema: 1,
                            roots: BTreeMap::from([("state".into(), state)]),
                        }),
                    },
                )
                .unwrap();
            // Deliberately no stored blob: this eligibility check is metadata
            // only. Native preparation must still reject missing bytes.
            assert_eq!(
                files.home_only_snapshot(&version, "home").unwrap(),
                expected
            );
        }
        let version = Uuid::new_v4().to_string();
        files
            .save_version(
                &version,
                Version {
                    head: String::new(),
                    parents: vec![],
                    entries: Entries::new(),
                    checksum: None,
                    rooted: Some(rooted::Snapshot {
                        schema: 1,
                        roots: BTreeMap::from([
                            ("state".into(), root.clone()),
                            ("workspace".into(), root),
                        ]),
                    }),
                },
            )
            .unwrap();
        assert!(!files.home_only_snapshot(&version, "home").unwrap());
    }
}
