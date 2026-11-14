//! Avoid constructing JSON values that legacy normalization immediately drops.
//! This is a borrowed projection, not a file/identity cache. The existing JSON
//! encoder and recursive cleanup still define the exact persisted checksum.
use super::{Entry, View};
use crate::workspace_metadata::WithoutSecurity;
use serde::{ser::SerializeMap, Serialize, Serializer};
use std::collections::BTreeMap;

pub(super) fn bytes(view: &View) -> Result<Vec<u8>, String> {
    super::encode_normalized_value(serde_json::to_value(Identity(view)).map_err(|e| e.to_string())?)
}

struct Identity<'a, T>(&'a T);
struct Entries<'a, T> {
    values: &'a BTreeMap<String, T>,
    git_index: bool,
}

impl<T> Serialize for Entries<'_, T>
where
    for<'a> Identity<'a, T>: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (name, value) in self.values {
            // Historical normalization removes every object key `security`,
            // including path-map members. It is not a new collection policy.
            if name == "security" || self.git_index && name == "index" { continue; }
            map.serialize_entry(name, &Identity(value))?;
        }
        map.end()
    }
}

impl Serialize for Identity<'_, View> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Exhaustive patterns make newly added evidence fields a compile-time
        // reminder to update the projection. No unknown fields are discarded.
        let View {
            schema, source, root_mode, root_extra, entries, hardlinks, repositories,
            git_entries, git_file, git_file_metadata, git_link, git_link_metadata,
            git_config, git_files, git_global,
        } = self.0;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("schema", schema)?;
        map.serialize_entry("source", source)?;
        map.serialize_entry("root_mode", root_mode)?;
        map.serialize_entry("root_extra", &WithoutSecurity(root_extra))?;
        map.serialize_entry("entries", &Entries { values: entries, git_index: false })?;
        map.serialize_entry("hardlinks", hardlinks)?;
        map.serialize_entry("repositories", &Entries { values: repositories, git_index: false })?;
        map.serialize_entry("git_entries", &git_entries.as_ref().map(|entries| Entries {
            values: entries, git_index: true,
        }))?;
        map.serialize_entry("git_file", git_file)?;
        map.serialize_entry("git_file_metadata", &git_file_metadata.as_ref().map(|(mode, extra)| {
            (*mode, WithoutSecurity(extra))
        }))?;
        map.serialize_entry("git_link", git_link)?;
        map.serialize_entry("git_link_metadata", &git_link_metadata.as_ref().map(|(mode, extra)| {
            (*mode, WithoutSecurity(extra))
        }))?;
        map.serialize_entry("git_config", git_config)?;
        map.serialize_entry("git_files", git_files)?;
        map.serialize_entry("git_global", git_global)?;
        map.end()
    }
}

impl Serialize for Identity<'_, Entry> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self.0 {
            Entry::Directory { mode, extra } => {
                map.serialize_entry("kind", "directory")?;
                map.serialize_entry("mode", mode)?;
                map.serialize_entry("extra", &WithoutSecurity(extra))?;
            }
            Entry::File { mode, blob, extra } => {
                map.serialize_entry("kind", "file")?;
                map.serialize_entry("mode", mode)?;
                map.serialize_entry("blob", blob)?;
                map.serialize_entry("extra", &WithoutSecurity(extra))?;
            }
            Entry::Special { special, mode, device, extra } => {
                map.serialize_entry("kind", "special")?;
                map.serialize_entry("special", special)?;
                map.serialize_entry("mode", mode)?;
                map.serialize_entry("device", device)?;
                map.serialize_entry("extra", &WithoutSecurity(extra))?;
            }
            Entry::Link { target, extra } => {
                map.serialize_entry("kind", "link")?;
                map.serialize_entry("target", target)?;
                map.serialize_entry("extra", &WithoutSecurity(extra))?;
            }
        }
        map.end()
    }
}
