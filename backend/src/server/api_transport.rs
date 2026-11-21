//! HTTP receipts are ephemeral transport evidence, not durable Run state.
//! Tokens include this backend's epoch: a restart can never re-execute an old token.
use crate::api_contract::{
    ApiErrorInfo, ErrorCode, OperationResponse, OperationState, OperationStatus,
};
use serde_json::{json, Value};
use sha1_checked::{Digest, Sha1};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const RETENTION_MS: u64 = 15 * 60 * 1000;
const MAX_RECEIPTS: usize = 4096;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
static INSTANCE: OnceLock<String> = OnceLock::new();
static RECEIPTS: OnceLock<Mutex<Receipts>> = OnceLock::new();
pub(super) fn instance() -> &'static str {
    INSTANCE.get_or_init(|| Uuid::new_v4().to_string())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn error(
    code: ErrorCode,
    message: impl Into<String>,
    retryable: bool,
    request_id: &str,
) -> (u16, Value) {
    let status = match code {
        ErrorCode::RunNotFound | ErrorCode::NotFound => 404,
        ErrorCode::Conflict
        | ErrorCode::OperationInProgress
        | ErrorCode::OperationOutcomeUnknown
        | ErrorCode::IdempotencyConflict => 409,
        ErrorCode::InternalError => 500,
        ErrorCode::CapacityExceeded => 429,
        ErrorCode::UnknownCommand | ErrorCode::InvalidRequest => 400,
    };
    let info = ApiErrorInfo {
        code,
        message: message.into(),
        retryable,
        request_id: request_id.into(),
    };
    (status, json!({"error":info.message,"errorInfo":info}))
}
pub(super) fn classify(message: String, request_id: &str) -> (u16, Value) {
    let code = if message == "Run not found" {
        ErrorCode::RunNotFound
    } else if message == "Unknown command" {
        ErrorCode::UnknownCommand
    } else if message.contains("not found") || message.contains("Not found") {
        ErrorCode::NotFound
    } else if message.contains("already")
        || message.contains("Wait for")
        || message.contains("stale")
        || message.contains("does not match")
        || message.contains("Another operation")
    {
        ErrorCode::Conflict
    } else if message.contains("poisoned")
        || message.contains("database is")
        || message.contains("disk I/O")
    {
        ErrorCode::InternalError
    } else {
        ErrorCode::InvalidRequest
    };
    error(code, message, false, request_id)
}

struct Receipt {
    fingerprint: Vec<u8>,
    created: u64,
    cached_bytes: usize,
    state: ReceiptState,
}
enum ReceiptState {
    Pending,
    Finished(Option<(u16, Value)>),
    Unknown,
}
#[derive(Default)]
struct Receipts {
    entries: HashMap<String, Receipt>,
    result_bytes: usize,
}

fn token_time(token: &str) -> Option<u64> {
    let mut parts = token.split(':');
    if parts.next()? != instance() {
        return None;
    }
    let timestamp = parts.next()?.parse::<u64>().ok()?;
    Uuid::parse_str(parts.next()?).ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(timestamp)
}

pub(super) enum Begin {
    New(ReceiptGuard),
    Reply(u16, Value),
}
pub(super) struct ReceiptGuard {
    token: String,
    finished: bool,
}
impl ReceiptGuard {
    pub(super) fn finish(mut self, status: u16, body: &Value) {
        if let Ok(mut receipts) = RECEIPTS.get_or_init(Default::default).lock() {
            let bytes = body.to_string().len();
            let cached =
                if bytes <= 1024 * 1024 && receipts.result_bytes + bytes <= MAX_RESULT_BYTES {
                    receipts.result_bytes += bytes;
                    Some((status, body.clone()))
                } else {
                    None
                };
            if let Some(receipt) = receipts.entries.get_mut(&self.token) {
                receipt.cached_bytes = if cached.is_some() { bytes } else { 0 };
                receipt.state = ReceiptState::Finished(cached);
            }
        }
        self.finished = true;
    }
}
impl Drop for ReceiptGuard {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut receipts) = RECEIPTS.get_or_init(Default::default).lock() {
                if let Some(receipt) = receipts.entries.get_mut(&self.token) {
                    receipt.state = ReceiptState::Unknown;
                }
            }
        }
    }
}

pub(super) fn begin(
    token: &str,
    command: &str,
    body: &Value,
    port: u16,
    request_id: &str,
) -> Begin {
    let now = now_ms();
    let Some(created) = token_time(token).filter(|time| {
        *time <= now.saturating_add(60_000) && now.saturating_sub(*time) < RETENTION_MS
    }) else {
        let (status, body) = error(ErrorCode::OperationOutcomeUnknown, "Operation belongs to a restarted backend or has expired; inspect current state before retrying", false, request_id);
        return Begin::Reply(status, body);
    };
    let mut hash = Sha1::new();
    hash.update(port.to_be_bytes());
    hash.update(command.as_bytes());
    hash.update([0]);
    hash.update(serde_json::to_vec(body).unwrap_or_default());
    let fingerprint = hash.try_finalize();
    if fingerprint.has_collision() {
        let (status, body) = error(
            ErrorCode::InvalidRequest,
            "Invalid operation fingerprint",
            false,
            request_id,
        );
        return Begin::Reply(status, body);
    }
    let fingerprint = fingerprint.hash();
    let mut receipts = RECEIPTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut retained_bytes = 0;
    receipts.entries.retain(|_, receipt| {
        let retain = matches!(receipt.state, ReceiptState::Pending)
            || now.saturating_sub(receipt.created) < RETENTION_MS;
        if retain {
            retained_bytes += receipt.cached_bytes;
        }
        retain
    });
    receipts.result_bytes = retained_bytes;
    if let Some(receipt) = receipts.entries.get(token) {
        let (status, body) = if receipt.fingerprint != &fingerprint[..] {
            error(
                ErrorCode::IdempotencyConflict,
                "Operation ID was already used for a different request",
                false,
                request_id,
            )
        } else {
            match &receipt.state {
                ReceiptState::Finished(Some((status, body))) => (*status, body.clone()),
                ReceiptState::Pending => error(
                    ErrorCode::OperationInProgress,
                    "Operation is still running; query operation_status",
                    true,
                    request_id,
                ),
                _ => error(
                    ErrorCode::OperationOutcomeUnknown,
                    "Operation result is unavailable; inspect current state before retrying",
                    false,
                    request_id,
                ),
            }
        };
        return Begin::Reply(status, body);
    }
    if receipts.entries.len() >= MAX_RECEIPTS {
        let (status, body) = error(
            ErrorCode::CapacityExceeded,
            "Too many operations; retry later",
            true,
            request_id,
        );
        return Begin::Reply(status, body);
    }
    receipts.entries.insert(
        token.into(),
        Receipt {
            fingerprint: fingerprint.to_vec(),
            created,
            cached_bytes: 0,
            state: ReceiptState::Pending,
        },
    );
    Begin::New(ReceiptGuard {
        token: token.into(),
        finished: false,
    })
}

pub(super) fn operation_status(token: &str) -> Value {
    // No fallback to replay or durable Run mutation, even after a restart.
    let receipts = RECEIPTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = now_ms();
    let (state, response) = match receipts
        .entries
        .get(token)
        .filter(|receipt| {
            matches!(receipt.state, ReceiptState::Pending)
                || now.saturating_sub(receipt.created) < RETENTION_MS
        })
        .map(|receipt| &receipt.state)
    {
        Some(ReceiptState::Pending) => (OperationState::Pending, None),
        Some(ReceiptState::Finished(response)) => (
            OperationState::Completed,
            response.as_ref().map(|(status, body)| OperationResponse {
                status: *status,
                body: body.clone(),
            }),
        ),
        _ => (OperationState::Unknown, None),
    };
    serde_json::to_value(OperationStatus {
        operation_id: token.into(),
        state,
        response,
    })
    .expect("JSON-only operation receipt")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn token() -> String {
        format!("{}:{}:{}", instance(), now_ms(), Uuid::new_v4())
    }
    #[test]
    fn receipts_deduplicate_pending_and_completed_writes_and_reject_changed_payloads() {
        let token = token();
        let body = json!({"action":"approve"});
        let Begin::New(guard) = begin(&token, "control", &body, 1421, "first") else {
            panic!()
        };
        assert_eq!(operation_status(&token)["state"], "pending");
        assert!(matches!(
            begin(&token, "control", &body, 1421, "second"),
            Begin::Reply(409, _)
        ));
        guard.finish(200, &json!({"result":{"runId":"run"}}));
        assert!(matches!(
            begin(&token, "control", &body, 1421, "third"),
            Begin::Reply(200, _)
        ));
        assert!(matches!(
            begin(&token, "control", &json!({"action":"stop"}), 1421, "fourth"),
            Begin::Reply(409, _)
        ));
        assert_eq!(operation_status(&token)["state"], "completed");
    }
    #[test]
    fn receipts_never_repeat_unknown_expired_or_restarted_operations() {
        let token = token();
        let Begin::New(guard) = begin(&token, "save_graph", &json!({}), 1421, "first") else {
            panic!()
        };
        drop(guard);
        assert_eq!(operation_status(&token)["state"], "unknown");
        assert!(matches!(
            begin(&token, "save_graph", &json!({}), 1421, "again"),
            Begin::Reply(409, _)
        ));
        for stale in [
            format!("{}:0:{}", instance(), Uuid::new_v4()),
            format!("{}:{}:{}", Uuid::new_v4(), now_ms(), Uuid::new_v4()),
        ] {
            assert!(matches!(
                begin(&stale, "save_graph", &json!({}), 1421, "stale"),
                Begin::Reply(409, _)
            ));
        }
    }
}
