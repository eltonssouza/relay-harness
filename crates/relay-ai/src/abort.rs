//! Cancellation, as `AbortController` and `AbortSignal` give it in TypeScript: a controller
//! aborts once, and every clone of its signal sees it, either by asking or by awaiting it.

use std::future::pending;
use std::sync::Arc;

use tokio::sync::watch;

/// Aborts the signals it hands out.
#[derive(Debug, Clone)]
pub struct AbortController {
    sender: Arc<watch::Sender<bool>>,
}

impl Default for AbortController {
    fn default() -> Self {
        AbortController::new()
    }
}

impl AbortController {
    pub fn new() -> Self {
        AbortController {
            sender: Arc::new(watch::channel(false).0),
        }
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal {
            receiver: Some(self.sender.subscribe()),
        }
    }

    pub fn abort(&self) {
        self.sender.send_replace(true);
    }
}

/// Whether, or when, a request was cancelled.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    /// `None` for a signal that never aborts.
    receiver: Option<watch::Receiver<bool>>,
}

impl AbortSignal {
    /// A signal nothing aborts.
    pub fn never() -> Self {
        AbortSignal::default()
    }

    pub fn is_aborted(&self) -> bool {
        self.receiver
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
    }

    /// Completes when the signal aborts; never, for a signal nothing can abort.
    pub async fn aborted(&self) {
        let Some(receiver) = &self.receiver else {
            return pending().await;
        };
        let mut receiver = receiver.clone();
        if receiver.wait_for(|aborted| *aborted).await.is_err() {
            // The controller is gone without aborting.
            pending::<()>().await;
        }
    }
}
