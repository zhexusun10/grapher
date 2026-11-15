//! Sorted, borrowed checksum serialization, without a JSON DOM. Schema 5 keeps
//! its historical security omissions; schema 6 includes ACLs and all project
//! path names. Both omit each native Git index's per-workspace stat cache.
use super::{Entry, View};
use crate::{workspace_metadata::ForViewIdentity, workspace_symlinks::Link};
use serde::{ser::SerializeMap, Serialize, Serializer};
use std::collections::BTreeMap;

pub(super) fn bytes(view: &View) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&Identity(view, view.schema >= 6)).map_err(|e| e.to_string())
}

/// Previous borrowed-projection/JSON-DOM path, retained only for local probes.
#[cfg(test)]
pub(super) fn buffered_bytes(view: &View) -> Result<Vec<u8>, String> {
    super::encode_normalized_value(serde_json::to_value(Identity(view, view.schema >= 6)).map_err(|e| e.to_string())?)
}

struct Identity<'a, T>(&'a T, bool);
struct Entries<'a, T> {
    values: &'a BTreeMap<String, T>,
    git_index: bool,
    security: bool,
}

impl<T> Serialize for Entries<'_, T>
where
    for<'a> Identity<'a, T>: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (name, value) in self.values {
            if !self.security && name == "security" || self.git_index && name == "index" { continue; }
            map.serialize_entry(name, &Identity(value, self.security))?;
        }
        map.end()
    }
}

impl Serialize for Identity<'_, View> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let View {
            schema, source, root_mode, root_extra, entries, hardlinks, repositories,
            git_entries, git_file, git_file_metadata, git_link, git_link_metadata,
            git_config, git_files, git_global,
        } = self.0;
        let security = self.1;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("entries", &Entries { values: entries, git_index: false, security })?;
        map.serialize_entry("git_config", git_config)?;
        map.serialize_entry("git_entries", &git_entries.as_ref().map(|entries| Entries {
            values: entries, git_index: true, security,
        }))?;
        map.serialize_entry("git_file", git_file)?;
        map.serialize_entry("git_file_metadata", &git_file_metadata.as_ref().map(|(mode, extra)| {
            (*mode, ForViewIdentity(extra, security))
        }))?;
        map.serialize_entry("git_files", &Entries { values: git_files, git_index: false, security })?;
        map.serialize_entry("git_global", git_global)?;
        map.serialize_entry("git_link", git_link)?;
        map.serialize_entry("git_link_metadata", &git_link_metadata.as_ref().map(|(mode, extra)| {
            (*mode, ForViewIdentity(extra, security))
        }))?;
        if security {
            map.serialize_entry("hardlinks", hardlinks)?;
        } else {
            map.serialize_entry("hardlinks", &crate::workspace_links::ForViewIdentity(hardlinks))?;
        }
        map.serialize_entry("repositories", &Entries { values: repositories, git_index: false, security })?;
        map.serialize_entry("root_extra", &ForViewIdentity(root_extra, security))?;
        map.serialize_entry("root_mode", root_mode)?;
        map.serialize_entry("schema", schema)?;
        map.serialize_entry("source", source)?;
        map.end()
    }
}

impl Serialize for Identity<'_, Entry> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self.0 {
            Entry::Directory { mode, extra } => {
                map.serialize_entry("extra", &ForViewIdentity(extra, self.1))?;
                map.serialize_entry("kind", "directory")?;
                map.serialize_entry("mode", mode)?;
            }
            Entry::File { mode, blob, extra } => {
                map.serialize_entry("blob", blob)?;
                map.serialize_entry("extra", &ForViewIdentity(extra, self.1))?;
                map.serialize_entry("kind", "file")?;
                map.serialize_entry("mode", mode)?;
            }
            Entry::Special { special, mode, device, extra } => {
                map.serialize_entry("device", device)?;
                map.serialize_entry("extra", &ForViewIdentity(extra, self.1))?;
                map.serialize_entry("kind", "special")?;
                map.serialize_entry("mode", mode)?;
                map.serialize_entry("special", special)?;
            }
            Entry::Link { target, extra } => {
                map.serialize_entry("extra", &ForViewIdentity(extra, self.1))?;
                map.serialize_entry("kind", "link")?;
                map.serialize_entry("target", &Identity(target, self.1))?;
            }
        }
        map.end()
    }
}

impl Serialize for Identity<'_, Link> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Link { value, project_absolute, kind } = self.0;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", kind)?;
        map.serialize_entry("project_absolute", project_absolute)?;
        map.serialize_entry("value", value)?;
        map.end()
    }
}

impl Serialize for Identity<'_, (String, bool)> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
