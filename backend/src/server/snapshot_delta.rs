use crate::api_contract::SnapshotDelta;
use serde_json::Value;

/// Deltas describe a browser projection, never persisted events or reducer input.
/// A changed historical prefix falls back to the full authoritative projection.
pub(super) fn between(
    base_version: &str,
    version: &str,
    base: &Value,
    next: &Value,
) -> Option<SnapshotDelta> {
    let (base, next) = (base.as_object()?, next.as_object()?);
    if base.get("runId") != next.get("runId") {
        return None;
    }
    let old_events = base.get("events")?.as_array()?;
    let new_events = next.get("events")?.as_array()?;
    if !new_events.starts_with(old_events) {
        return None;
    }
    let delta = SnapshotDelta {
        base_version: base_version.into(),
        version: version.into(),
        set: next
            .iter()
            .filter(|(key, value)| key.as_str() != "events" && base.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        removed: base
            .keys()
            .filter(|key| !next.contains_key(*key))
            .cloned()
            .collect(),
        after_sequence: old_events
            .last()
            .and_then(|event| event["sequence"].as_i64())
            .unwrap_or(0),
        events: new_events[old_events.len()..].to_vec(),
    };
    Some(delta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn browser_delta_preserves_deletions_and_event_prefix_and_skips_unchanged_graph() {
        let graph = "x".repeat(4000);
        let base = json!({"runId":"run", "graph":graph, "phase":"running", "old":true,
            "events":[{"sequence":2,"type":"started"}]});
        let next = json!({"runId":"run", "graph":graph, "phase":"completed", "new":null,
            "events":[{"sequence":2,"type":"started"},{"sequence":4,"type":"finished"}]});
        let delta = between("epoch:1", "epoch:2", &base, &next).unwrap();
        assert_eq!(delta.after_sequence, 2);
        assert_eq!(delta.removed, ["old"]);
        assert!(!delta.set.contains_key("graph"));
        let mut applied = base.clone();
        for key in &delta.removed {
            applied.as_object_mut().unwrap().remove(key);
        }
        for (key, value) in delta.set {
            applied[&key] = value;
        }
        applied["events"]
            .as_array_mut()
            .unwrap()
            .extend(delta.events);
        assert_eq!(applied, next);
        let mut rewritten = next.clone();
        rewritten["events"][0]["type"] = json!("changed");
        assert!(between("1", "2", &base, &rewritten).is_none());
        rewritten["runId"] = json!("other");
        assert!(between("1", "2", &base, &rewritten).is_none());
    }
}
