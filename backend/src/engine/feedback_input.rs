//! Correlate one feedback user turn without depending on Pi's image/input normalization.
//! The envelope lives in Pi's durable history, not model context or Grapher's display log.
use serde_json::Value;

const OPEN: &str = "\n\n<grapher-feedback-id>";
const CLOSE: &str = "</grapher-feedback-id>";

pub(crate) fn prompt(text: &str, delivery_id: Option<&str>) -> String {
    match delivery_id {
        Some(id) => format!("{text}{OPEN}{id}{CLOSE}"),
        None => text.into(),
    }
}

fn envelopes(text: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    text.match_indices(OPEN).filter_map(|(start, _)| {
        let rest = &text[start + OPEN.len()..];
        let id = rest.get(..36)?;
        let after = rest.get(36..)?.strip_prefix(CLOSE)?;
        let parsed = uuid::Uuid::parse_str(id).ok()?;
        if parsed.to_string() != id || !(after.is_empty() || after.starts_with('\n')) {
            return None;
        }
        Some((start, start + OPEN.len() + id.len() + CLOSE.len(), id))
    })
}

pub(crate) fn identifies(text: &str, delivery_id: &str) -> bool {
    let mut ids = envelopes(text);
    ids.next().is_some_and(|(_, _, id)| id == delivery_id) && ids.next().is_none()
}

pub(crate) fn strip(text: &str) -> String {
    let mut clean = String::new();
    let mut cursor = 0;
    for (start, end, _) in envelopes(text) {
        clean.push_str(&text[cursor..start]);
        cursor = end;
    }
    clean.push_str(&text[cursor..]);
    clean
}

fn project_message(message: &mut Value) {
    if message["role"] != "user" {
        return;
    }
    if let Some(text) = message["content"].as_str() {
        message["content"] = strip(text).into();
    } else if let Some(parts) = message["content"].as_array_mut() {
        for part in parts {
            if part["type"] == "text" {
                if let Some(text) = part["text"].as_str() {
                    part["text"] = strip(text).into();
                }
            }
        }
    }
}

pub(super) fn project_event(event: &mut Value) {
    if let Some(message) = event.get_mut("message") {
        project_message(message);
    }
    if let Some(message) = event.get_mut("entry").and_then(|entry| entry.get_mut("message")) {
        project_message(message);
    }
    if let Some(messages) = event.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            project_message(message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn feedback_identity_survives_normalization_but_not_other_turns() {
        let id = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        let raw = prompt("review screenshot", Some(&id));
        let stored = format!("{raw}\n\n[Image: original 3000x2000, displayed at 2000x1333.]");
        assert!(identifies(&stored, &id));
        assert!(!identifies(&stored, &other));
        assert!(!identifies(&format!("{raw}{}", prompt("other turn", Some(&other))), &id));
        assert!(!identifies("review screenshot", &id));
        assert_eq!(strip(&stored), "review screenshot\n\n[Image: original 3000x2000, displayed at 2000x1333.]");
        assert_eq!(strip("literal\n\n<grapher-feedback-id>not-an-id</grapher-feedback-id>"), "literal\n\n<grapher-feedback-id>not-an-id</grapher-feedback-id>");
    }

    #[test]
    fn feedback_envelopes_are_not_displayed_and_do_not_rewrite_other_content() {
        let id = uuid::Uuid::new_v4().to_string();
        let raw = prompt("review", Some(&id));
        let user = json!({"role":"user", "content":[{"type":"text", "text":raw}, {"type":"image", "data":"bytes"}]});
        let mut event = json!({"message":user, "entry":{"message":user}, "messages":[user, {"role":"assistant", "content":raw}], "args":{"text":raw}});
        project_event(&mut event);
        assert_eq!(event["message"]["content"][0]["text"], "review");
        assert_eq!(event["entry"]["message"]["content"][0]["text"], "review");
        assert_eq!(event["messages"][0]["content"][1]["data"], "bytes");
        assert_eq!(event["messages"][1]["content"], raw);
        assert_eq!(event["args"]["text"], raw);
    }
}
