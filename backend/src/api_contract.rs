//! Browser wire DTOs. Persisted events/checkpoints deliberately do not use these.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    RunNotFound,
    NotFound,
    Conflict,
    InvalidRequest,
    InternalError,
    UnknownCommand,
    OperationInProgress,
    OperationOutcomeUnknown,
    IdempotencyConflict,
    CapacityExceeded,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorInfo {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub request_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPollRequest {
    pub version: Option<String>,
    #[ts(optional)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub delta: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDelta {
    pub base_version: String,
    pub version: String,
    pub set: BTreeMap<String, Value>,
    pub removed: Vec<String>,
    #[ts(type = "number")]
    pub after_sequence: i64,
    #[ts(type = "GraphEvent[]")]
    pub events: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub kind: String,
    pub nodes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPollResponse {
    pub version: String,
    #[ts(type = "Snapshot | null")]
    pub snapshot: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub delta: Option<SnapshotDelta>,
    pub activity: Vec<RuntimeActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub busy: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutputPage {
    pub run_id: String,
    pub execution_id: String,
    pub content: String,
    #[ts(type = "number")]
    pub start_offset: usize,
    #[ts(type = "number")]
    pub next_offset: usize,
    #[ts(type = "number")]
    pub total_bytes: usize,
    pub complete: bool,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, number>")]
    pub steer_offsets: Option<BTreeMap<String, usize>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steer_offsets_authoritative: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOutputPage {
    pub planning_id: String,
    pub role: String,
    pub content: String,
    #[ts(type = "number")]
    pub start_offset: u64,
    #[ts(type = "number")]
    pub next_offset: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub complete: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchMatch {
    pub run_id: String,
    pub conversation_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_type: Option<String>,
    pub role: String,
    pub source_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution_id: Option<String>,
    pub snippet_before: String,
    pub snippet_match: String,
    pub snippet_after: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub timestamp: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchResponse {
    pub query: String,
    pub matches: Vec<ConversationSearchMatch>,
    #[ts(type = "number")]
    pub total_matches: usize,
    #[ts(type = "number")]
    pub matched_conversations: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum OperationState {
    Pending,
    Completed,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub operation_id: String,
    pub state: OperationState,
    pub response: Option<OperationResponse>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlannerOutputFrame {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event: Option<Value>,
}
impl PlannerOutputFrame {
    pub fn from_line(line: &str) -> Self {
        match serde_json::from_str(line) {
            Ok(event) => Self {
                raw: None,
                event: Some(event),
            },
            Err(_) => Self {
                raw: Some(line.into()),
                event: None,
            },
        }
    }
}

/// The same read/mutation classification drives desktop retry and receipts.
/// Unknown commands are conservative: they must never be transport-replayed.
pub const READ_OPERATIONS: &[(&str, &[&str])] = &[
    ("provider_auth", &["catalog", "poll", "model_visibility"]),
    ("pi_extensions", &["catalog"]),
    ("extension_command", &["catalog"]),
    ("composer_command", &["catalog", "poll"]),
];
pub const READ_COMMANDS: &[&str] = &[
    "terminal_read",
    "bootstrap",
    "host_preflight",
    "history",
    "snapshot",
    "snapshot_if_changed",
    "detect_repository",
    "repository_status",
    "get_planning",
    "list_plannings",
    "get_planning_snapshot",
    "get_execution_output",
    "get_planning_output",
    "search_conversations",
    "get_file_changes",
    "get_file_diff",
    "get_workspace_image",
    "get_merger_prompt",
    "list_skills",
    "list_files",
    "compile_graph",
    "environment_capabilities",
    "get_cleanup_status",
    "result_descriptor",
    "operation_status",
];
pub fn is_read(command: &str, body: &Value) -> bool {
    READ_COMMANDS.contains(&command)
        || READ_OPERATIONS.iter().any(|(name, operations)| {
            *name == command
                && body["operation"]
                    .as_str()
                    .is_some_and(|op| operations.contains(&op))
        })
}

pub fn typescript() -> String {
    let declarations = [
        crate::snapshot_view::ExecutionMetadata::<'static>::decl(),
        crate::snapshot_view::SnapshotMetadata::<'static>::decl(),
        Value::decl(),
        ErrorCode::decl(),
        ApiErrorInfo::decl(),
        SnapshotPollRequest::decl(),
        SnapshotDelta::decl(),
        RuntimeActivity::decl(),
        SnapshotPollResponse::decl(),
        ExecutionOutputPage::decl(),
        PlanningOutputPage::decl(),
        ConversationSearchMatch::decl(),
        ConversationSearchResponse::decl(),
        OperationResponse::decl(),
        OperationState::decl(),
        OperationStatus::decl(),
        PlannerOutputFrame::decl(),
    ];
    format!("// Generated by `npm run api:generate`; edit backend/src/api_contract.rs and snapshot_view.rs.\n\
        import type {{ GraphEvent, ExecutionMetrics, FileChangeSummary, Graph, Config, ConversationModelConfig, Plan, NodeState, PlanningSummary, Publication, RunMetrics }} from '../types';\n\n{}\n\
        export const READ_COMMANDS = {} as const;\nexport const READ_OPERATIONS = {} as const;\n",
        declarations.into_iter().map(|decl| format!("export {decl}\n")).collect::<String>(),
        serde_json::to_string(READ_COMMANDS).unwrap(),
        serde_json::to_string(&READ_OPERATIONS.iter().copied().collect::<BTreeMap<_, _>>()).unwrap())
}

#[cfg(test)]
mod tests {
    #[test]
    fn browser_api_bindings_match_the_rust_dtos() {
        assert_eq!(
            super::typescript(),
            include_str!("../../src/services/apiContract.generated.ts"),
            "Run npm run api:generate after changing browser DTOs"
        );
    }
}
