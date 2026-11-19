//! Pillar 3: less context, better agents. Port of `packages/agent/src/harness/context.ts`.
//!
//! The policy works on what it needs of a transcript, not on the messages themselves: the tool
//! calls of assistant messages and the size and outcome of each tool result. It returns the stub
//! for every elided result; the runtime replaces those results' content in the request.

use std::collections::{HashMap, HashSet};

use crate::effects::{
    classify_tool_call, is_mutation, normalize_path, relative_to_root, ClassifyContext, ToolCall,
    ToolEffect, ToolEffectKind,
};
use crate::text::{clip, js_length};

/// A tool call of an assistant message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextToolCall {
    pub id: String,
    pub call: ToolCall,
    /// `JSON.stringify(arguments)`, for the digest of a call that names no command or path.
    pub arguments_json: String,
    /// The effect a custom classifier gave the call (MCP hints); None to use the default classification.
    pub effect: Option<ToolEffect>,
}

/// What the policy reads of one transcript message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextMessage {
    Assistant {
        tool_calls: Vec<ContextToolCall>,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        chars: usize,
        is_error: bool,
    },
    Other,
}

#[derive(Debug, Clone)]
pub struct ContextPolicyOptions {
    pub keep_recent: usize,
    pub batch_size: usize,
    pub min_elide_chars: usize,
    pub max_digest_entries: usize,
    pub cwd: Option<String>,
}

impl Default for ContextPolicyOptions {
    fn default() -> Self {
        Self {
            keep_recent: 6,
            batch_size: 6,
            min_elide_chars: 1500,
            max_digest_entries: 30,
            cwd: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestEntry {
    pub tool: String,
    pub call: String,
    pub ok: bool,
    pub chars: usize,
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContextStats {
    pub elided_results: usize,
    pub elided_chars: i64,
    pub batches: usize,
}

/// Recent-window pruning with a deterministic progress digest.
#[derive(Debug, Clone)]
pub struct ContextWindowPolicy {
    options: ContextPolicyOptions,
    elided: HashMap<String, String>,
    digest: Vec<DigestEntry>,
    stats: ContextStats,
}

impl ContextWindowPolicy {
    pub fn new(mut options: ContextPolicyOptions) -> Self {
        options.keep_recent = options.keep_recent.max(1);
        options.batch_size = options.batch_size.max(1);
        Self {
            options,
            elided: HashMap::new(),
            digest: Vec::new(),
            stats: ContextStats::default(),
        }
    }

    /// Apply the policy to the messages of one request: the stub of every elided tool result, by call id.
    pub fn transform(&mut self, messages: &[ContextMessage]) -> Vec<(String, String)> {
        let mut tool_calls: HashMap<&str, &ContextToolCall> = HashMap::new();
        let mut results = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            match message {
                ContextMessage::Assistant { tool_calls: calls } => {
                    for call in calls {
                        tool_calls.insert(&call.id, call);
                    }
                }
                ContextMessage::ToolResult { .. } => results.push(index),
                ContextMessage::Other => {}
            }
        }
        self.advance_batch(messages, &results, &tool_calls);
        messages
            .iter()
            .filter_map(|message| match message {
                ContextMessage::ToolResult { tool_call_id, .. } => self
                    .elided
                    .get(tool_call_id)
                    .map(|stub| (tool_call_id.clone(), stub.clone())),
                _ => None,
            })
            .collect()
    }

    /// Forget what was elided and the digest.
    pub fn reset(&mut self) {
        self.elided.clear();
        self.digest.clear();
    }

    /// Compact digest of elided work, or None when nothing was elided.
    pub fn render_progress(&self) -> Option<String> {
        if self.digest.is_empty() {
            return None;
        }
        let shown = &self.digest[self
            .digest
            .len()
            .saturating_sub(self.options.max_digest_entries)..];
        let omitted = self.digest.len() - shown.len();
        let mut lines = vec![format!(
            "Earlier tool results elided from context ({} calls). Progress so far:",
            self.digest.len()
        )];
        if omitted > 0 {
            lines.push(format!("- ... {omitted} earlier calls"));
        }
        for entry in shown {
            lines.push(format!(
                "- {} {}: {}{}",
                entry.tool,
                entry.call,
                if entry.ok { "ok" } else { "error" },
                if entry.stale {
                    " (file changed later)"
                } else {
                    ""
                }
            ));
        }
        Some(lines.join("\n"))
    }

    pub fn stats(&self) -> ContextStats {
        self.stats
    }

    fn effect_of(call: &ContextToolCall) -> ToolEffect {
        call.effect
            .clone()
            .unwrap_or_else(|| classify_tool_call(&call.call, &[], &ClassifyContext::default()))
    }

    fn same_path(&self, path: &str) -> String {
        let normalized = normalize_path(&path.replace('\\', "/"));
        match self
            .options
            .cwd
            .as_deref()
            .and_then(|cwd| relative_to_root(&normalized, cwd))
        {
            Some(relative) if !relative.is_empty() => relative,
            _ => normalized,
        }
    }

    fn changed_paths(&self, effect: &ToolEffect) -> Vec<String> {
        let named = if is_mutation(effect.kind) {
            effect.paths.clone()
        } else {
            Vec::new()
        };
        named
            .iter()
            .chain(effect.writes.iter().flatten())
            .map(|path| self.same_path(path))
            .collect()
    }

    fn changed_after(
        &self,
        messages: &[ContextMessage],
        index: usize,
        tool_calls: &HashMap<&str, &ContextToolCall>,
        paths: &HashSet<String>,
    ) -> bool {
        messages[index + 1..].iter().any(|message| match message {
            ContextMessage::ToolResult {
                tool_call_id,
                is_error: false,
                ..
            } => tool_calls.get(tool_call_id.as_str()).is_some_and(|call| {
                self.changed_paths(&Self::effect_of(call))
                    .iter()
                    .any(|path| paths.contains(path))
            }),
            _ => false,
        })
    }

    fn advance_batch(
        &mut self,
        messages: &[ContextMessage],
        results: &[usize],
        tool_calls: &HashMap<&str, &ContextToolCall>,
    ) {
        let aged = &results[..results.len().saturating_sub(self.options.keep_recent)];
        let candidates: Vec<usize> = aged
            .iter()
            .copied()
            .filter(|&index| match &messages[index] {
                ContextMessage::ToolResult {
                    tool_call_id,
                    chars,
                    ..
                } => {
                    !self.elided.contains_key(tool_call_id)
                        && *chars >= self.options.min_elide_chars
                }
                _ => false,
            })
            .collect();
        if candidates.len() < self.options.batch_size {
            return;
        }
        self.stats.batches += 1;
        for index in candidates {
            let ContextMessage::ToolResult {
                tool_call_id,
                tool_name,
                chars,
                is_error,
            } = &messages[index]
            else {
                continue;
            };
            let call = tool_calls.get(tool_call_id.as_str()).copied();
            let effect = call.map(Self::effect_of);
            let label = match (&effect, call) {
                (Some(effect), _)
                    if effect
                        .command
                        .as_deref()
                        .is_some_and(|command| !command.is_empty()) =>
                {
                    format!(
                        "`{}`",
                        clip(effect.command.as_deref().unwrap_or_default(), 100)
                    )
                }
                (Some(effect), _) if !effect.paths.is_empty() => effect.paths.join(", "),
                (_, Some(call)) => clip(&call.arguments_json, 100),
                _ => String::new(),
            };
            let stale = effect.as_ref().is_some_and(|effect| {
                effect.kind == ToolEffectKind::Read && !effect.paths.is_empty() && {
                    let paths: HashSet<String> = effect
                        .paths
                        .iter()
                        .map(|path| self.same_path(path))
                        .collect();
                    self.changed_after(messages, index, tool_calls, &paths)
                }
            });
            let stub = format!(
                "[harness:context] Result elided to keep context focused: {tool_name} {label} ({chars} chars, {}).{} Re-run the call if you need the content.",
                if *is_error { "error" } else { "ok" },
                if stale { " The file was changed later, so this content was stale." } else { "" }
            );
            self.stats.elided_results += 1;
            self.stats.elided_chars += *chars as i64 - js_length(&stub) as i64;
            self.digest.push(DigestEntry {
                tool: tool_name.clone(),
                call: label,
                ok: !is_error,
                chars: *chars,
                stale,
            });
            self.elided.insert(tool_call_id.clone(), stub);
        }
    }
}
