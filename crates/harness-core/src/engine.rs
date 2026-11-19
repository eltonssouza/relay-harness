//! The three pillars composed: what `HarnessCore` in `packages/agent/src/harness/harness-core.ts`
//! decides, without its hooks into the agent loop, which stay with the runtime.

use crate::alignment::{
    requests_action, AlignmentDecision, AlignmentPolicy, AlignmentPolicyOptions,
    PAIR_PROGRAMMING_GUIDELINES,
};
use crate::context::{ContextMessage, ContextPolicyOptions, ContextWindowPolicy};
use crate::effects::{classify_tool_call, ClassifyContext, ToolCall, ToolEffect};
use crate::evidence::{format_verification_request, CompletionReport, EvidenceLedger};

#[derive(Debug, Clone)]
pub struct EngineOptions {
    /// None disables the pillar.
    pub alignment: Option<AlignmentPolicyOptions>,
    /// Verification requests per developer request; None disables the evidence pillar.
    pub evidence_max_gates: Option<usize>,
    pub context: Option<ContextPolicyOptions>,
    pub verify_commands: Vec<String>,
    pub workspace: ClassifyContext,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            alignment: Some(AlignmentPolicyOptions::default()),
            evidence_max_gates: Some(1),
            context: Some(ContextPolicyOptions::default()),
            verify_commands: Vec::new(),
            workspace: ClassifyContext::default(),
        }
    }
}

/// The assessment of a turn's final message.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalAssessment {
    pub report: CompletionReport,
    /// The `[harness:evidence]` message to send back to the agent, when the report is gated.
    pub verification_request: Option<String>,
}

/// The harness pillars of one agent.
#[derive(Debug, Clone)]
pub struct HarnessEngine {
    pub alignment: Option<AlignmentPolicy>,
    pub evidence: Option<EvidenceLedger>,
    pub context: Option<ContextWindowPolicy>,
    verify_commands: Vec<String>,
    workspace: ClassifyContext,
}

impl HarnessEngine {
    pub fn new(options: EngineOptions) -> Self {
        let verify_commands: Vec<String> = options
            .verify_commands
            .into_iter()
            .filter(|command| !command.trim().is_empty())
            .collect();
        Self {
            alignment: options.alignment.map(AlignmentPolicy::new),
            evidence: options
                .evidence_max_gates
                .map(|gates| EvidenceLedger::new(gates, options.workspace.cwd.clone())),
            context: options.context.map(|mut context| {
                if context.cwd.is_none() {
                    context.cwd = options.workspace.cwd.clone();
                }
                ContextWindowPolicy::new(context)
            }),
            verify_commands,
            workspace: options.workspace,
        }
    }

    /// The effect of a tool call: `custom` when a classifier declared it, otherwise by tool name and arguments.
    pub fn classify(&self, tool_call: &ToolCall, custom: Option<ToolEffect>) -> ToolEffect {
        custom.unwrap_or_else(|| {
            classify_tool_call(tool_call, &self.verify_commands, &self.workspace)
        })
    }

    /// A developer request starts: reset per-request evidence.
    pub fn begin_request(&mut self, text: &str) {
        if let Some(evidence) = &mut self.evidence {
            evidence.begin_request(requests_action(text));
        }
    }

    /// A developer message arrived. Returns whether it recorded a correction.
    pub fn observe_developer_message(
        &mut self,
        text: &str,
        timestamp: f64,
        after_agent_work: bool,
    ) -> bool {
        self.alignment.as_mut().is_some_and(|alignment| {
            alignment.observe_developer_message(text, timestamp, after_agent_work)
        })
    }

    pub fn prompt_guidelines(&self) -> &'static [&'static str] {
        if self.alignment.is_some() {
            PAIR_PROGRAMMING_GUIDELINES
        } else {
            &[]
        }
    }

    /// Alignment check for a validated tool call.
    pub fn check(&mut self, tool_name: &str, effect: &ToolEffect) -> AlignmentDecision {
        match &mut self.alignment {
            Some(alignment) => alignment.check(tool_name, effect),
            None => AlignmentDecision::Allow { via: None },
        }
    }

    pub fn resolve_authorization(
        &mut self,
        effect: &ToolEffect,
        fingerprint: &str,
        approved: Option<bool>,
    ) -> AlignmentDecision {
        match &mut self.alignment {
            Some(alignment) => alignment.resolve_authorization(effect, fingerprint, approved),
            None => AlignmentDecision::Allow { via: None },
        }
    }

    pub fn begin_tool_call(&mut self) -> Option<f64> {
        self.evidence.as_mut().map(EvidenceLedger::begin_tool_call)
    }

    pub fn record_tool_outcome(
        &mut self,
        effect: &ToolEffect,
        is_error: bool,
        output: &str,
        started_at: Option<f64>,
    ) {
        if let Some(evidence) = &mut self.evidence {
            evidence.record_tool_outcome(effect, is_error, output, started_at);
        }
    }

    /// The conversation changed under the pillars (another branch): drop what belongs to the old one.
    pub fn resync(&mut self) {
        if let Some(context) = &mut self.context {
            context.reset();
        }
        if let Some(alignment) = &mut self.alignment {
            alignment.reset_conversation_state();
        }
    }

    /// The stub of every elided tool result of one request.
    pub fn transform_context(&mut self, messages: &[ContextMessage]) -> Vec<(String, String)> {
        match &mut self.context {
            Some(context) => context.transform(messages),
            None => Vec::new(),
        }
    }

    /// Harness state restated next to the latest message, or None when there is none. `slices` is
    /// the slice signals' reminder, which the runtime measures.
    pub fn render_state(&self, slices: Option<&str>) -> Option<String> {
        let mut sections: Vec<String> = Vec::new();
        if let Some(alignment) = &self.alignment {
            if let Some(correction) = alignment.render_correction() {
                sections.push(correction.to_string());
            }
            if let Some(constraints) = alignment.render_constraints() {
                sections.push(constraints);
            }
        }
        if let Some(pending) = self
            .evidence
            .as_ref()
            .and_then(EvidenceLedger::pending_changes)
        {
            let shown = pending
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            sections.push(format!(
                "Changed since the last passing check: {shown}{}. Verify before reporting completion.",
                if pending.len() > 8 { ", ..." } else { "" }
            ));
        }
        if let Some(slices) = slices {
            sections.push(slices.to_string());
        }
        if let Some(progress) = self
            .context
            .as_ref()
            .and_then(ContextWindowPolicy::render_progress)
        {
            sections.push(progress);
        }
        if sections.is_empty() {
            return None;
        }
        let mut all = vec!["Generated by the harness, not written by the developer.".to_string()];
        all.extend(sections);
        Some(all.join("\n\n"))
    }

    /// Assess a final assistant message; the verification request is set when the report is gated.
    pub fn assess_final_message(&mut self, text: &str) -> Option<FinalAssessment> {
        let evidence = self.evidence.as_mut()?;
        let mut report = evidence.assess(text);
        let gated = evidence.should_gate(&mut report);
        let verification_request =
            gated.then(|| format_verification_request(&report, &self.verify_commands));
        Some(FinalAssessment {
            report,
            verification_request,
        })
    }
}
