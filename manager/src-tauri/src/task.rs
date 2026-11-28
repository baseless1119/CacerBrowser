//! Shared progress/cancellation state and network routing helpers used by
//! both runtime installation (`runtime.rs`) and self-updates (`update.rs`).
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};

/// Public GitHub reverse proxies tried in order before hitting GitHub directly.
pub const MIRRORS: [&str; 5] = [
    "https://ghfast.top",
    "https://gh-proxy.com",
    "https://github.moeyy.xyz",
    "https://ghproxy.net",
    "https://gh.llkk.cc",
];

#[derive(Clone, Default, Serialize)]
pub struct TaskStatus {
    pub busy: bool,
    pub message: String,
    pub downloaded: u64,
    pub total: u64,
}

/// Reusable state machine for a single long-running cancellable background task.
pub struct TaskControl {
    status: Mutex<TaskStatus>,
    cancel: AtomicBool,
}

impl TaskControl {
    pub const fn new() -> Self {
        Self {
            status: Mutex::new(TaskStatus {
                busy: false,
                message: String::new(),
                downloaded: 0,
                total: 0,
            }),
            cancel: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> TaskStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn cancelled(&self, message: &str) -> Result<(), String> {
        if self.is_cancelled() {
            Err(message.into())
        } else {
            Ok(())
        }
    }

    pub fn progress(&self, message: &str, downloaded: u64, total: u64) {
        let mut state = self.status.lock().unwrap();
        state.message = message.into();
        state.downloaded = downloaded;
        state.total = total;
    }

    pub fn run<T>(
        &self,
        busy_error: &str,
        initial_message: &str,
        initial_total: u64,
        done_message: &str,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        {
            let mut state = self.status.lock().unwrap();
            if state.busy {
                return Err(busy_error.into());
            }
            self.cancel.store(false, Ordering::Relaxed);
            *state = TaskStatus {
                busy: true,
                message: initial_message.into(),
                downloaded: 0,
                total: initial_total,
            };
        }
        let result = work();
        let mut state = self.status.lock().unwrap();
        state.busy = false;
        state.message = match &result {
            Ok(_) => done_message.into(),
            Err(error) => error.clone(),
        };
        result
    }
}

/// Normalize Windows WinINET `ProxyServer` strings (`http=...;https=...` or `host:port`).
pub fn windows_proxy(server: &str) -> Option<String> {
    let value = server
        .split(';')
        .find_map(|entry| entry.strip_prefix("https="))
        .or_else(|| server.split(';').find_map(|entry| entry.strip_prefix("http=")))
        .or_else(|| (!server.contains('=')).then_some(server))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    })
}

/// Read the active Windows system proxy URL if enabled.
pub fn system_proxy_url() -> Option<String> {
    let system = super::system_proxy().ok()?;
    if system["enabled"].as_bool() != Some(true) {
        return None;
    }
    system["server"].as_str().and_then(windows_proxy)
}
