//! Pillar 2: success requires evidence. Port of `packages/agent/src/harness/evidence.ts`.
//!
//! The ledger records what the tool calls of a developer request did (changes, checks and their
//! outcome) and compares the final message's claim with that record.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use crate::effects::{is_mutation, normalize_path, relative_to_root, ToolEffect, ToolEffectKind};
use crate::text::{clip, trim_js, words_pattern, Pattern, ASCII_B};

macro_rules! pattern {
    ($name:ident, $init:expr) => {
        fn $name() -> &'static Pattern {
            static CELL: OnceLock<Pattern> = OnceLock::new();
            CELL.get_or_init(|| $init)
        }
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionStatus {
    Verified,
    Unverified,
    Contradicted,
    NoEffect,
    Acknowledged,
    Question,
    NoClaim,
}

impl CompletionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Unverified => "unverified",
            Self::Contradicted => "contradicted",
            Self::NoEffect => "no-effect",
            Self::Acknowledged => "acknowledged",
            Self::Question => "question",
            Self::NoClaim => "no-claim",
        }
    }

    /// Whether the report goes back to the agent as a verification request.
    pub fn is_flagged(self) -> bool {
        matches!(self, Self::Unverified | Self::Contradicted | Self::NoEffect)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerificationRecord {
    pub command: String,
    pub passed: bool,
    /// When the check started: it covers the changes that ended before.
    pub step: f64,
    pub name_filtered: bool,
    pub empty: bool,
    pub scope: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletionReport {
    pub status: CompletionStatus,
    pub claimed: bool,
    pub changed_paths: Vec<String>,
    pub mutations: usize,
    pub verifications: Vec<VerificationRecord>,
    pub detail: Option<String>,
    pub gated: bool,
}

pattern!(
    empty_run,
    Pattern::new(
        &[
            r"(?i:no test files? found)",
            r"(?i:no tests? (?:found|ran|were run|were executed|to run|collected))",
            r"(?i:collected 0 items)",
            r"(?m:^\s*Tests:\s+0 total)",
            r"(?m:^\s*Test Suites:\s+0 total)",
            r"(?m:^(?:#|ℹ)\s*tests\s+0\s*$)",
            &format!(r"(?m:^\s*0 passing{ASCII_B})"),
            &format!(r"{ASCII_B}Ran 0 tests{ASCII_B}"),
            &format!(r"{ASCII_B}0 examples, 0 failures{ASCII_B}"),
        ]
        .join("|")
    )
);
pattern!(
    name_filter,
    Pattern::new(
        r"\s(?:-t|--testNamePattern|--test-name-pattern|--grep|-g|-k|--filter|--test-name)(?:[\s=]|$)"
    )
);
pattern!(
    completion_claim,
    words_pattern(&[
        "done",
        "complete",
        "completed",
        "finished",
        "implemented",
        "fixed",
        "resolved",
        "all set",
        "ready",
        "works",
        "working",
        "successfully",
        "concluído",
        "concluída",
        "concluido",
        "pronto",
        "pronta",
        "feito",
        "finalizado",
        "finalizada",
        "implementado",
        "implementada",
        "corrigido",
        "corrigida",
        "resolvido",
        "resolvida",
        "funcionando",
        "funciona",
        "com sucesso",
    ])
);
pattern!(
    check_claim,
    words_pattern(&[
        "tests? (?:now )?pass(?:es|ing|ed)?",
        "all tests pass",
        "(?:build|check|lint|type ?check)s? (?:now )?(?:pass(?:es|ed)?|succeed(?:s|ed)?|is green|are green)",
        "verified",
        "validated",
        "testes (?:agora )?passa(?:m|ram|ndo)",
        "(?:build|check|lint) (?:agora )?(?:passa|passou|passando)",
        "verificad[oa]s?",
        "validad[oa]s?",
    ])
);
pattern!(
    all_tests_claim,
    words_pattern(&[
        "all (?:the )?tests (?:now )?pass(?:es|ing|ed)?",
        "(?:the )?(?:whole|full|entire) (?:test )?suite (?:now )?(?:passes|passed|is green)",
        "todos os testes (?:agora )?passa(?:m|ram|ndo)",
        "(?:a )?suíte (?:inteira|completa) (?:agora )?(?:passa|passou|está verde)",
    ])
);
pattern!(
    acknowledgement,
    words_pattern(&[
        "not (?:yet )?(?:verified|tested|run|validated)",
        "untested",
        "unverified",
        "(?:could not|couldn't|unable to|did not|didn't|haven't|have not|hasn't|has not) (?:run|verify|test|validate)",
        "still fail(?:s|ing)?",
        "(?:tests?|checks?|builds?|lint|type ?checks?) (?:still )?fail(?:s|ing)?",
        "não (?:foi |foram )?(?:verificad|testad|rodad|executad|validad)[oa]s?",
        "não (?:consegui|pude) (?:rodar|executar|testar|verificar|validar)",
        "não (?:verifiquei|testei|rodei|executei|validei)",
        "sem verificação",
        "(?:testes?|checks?|builds?|lint) (?:ainda )?(?:falh(?:a|am|ando))",
        "ainda falha",
    ])
);
pattern!(
    past_failure,
    words_pattern(&[
        "(?:tests?|checks?|builds?|lint|type ?checks?) failed",
        "(?:testes?|checks?|builds?|lint) (?:falhou|falharam)"
    ])
);
pattern!(
    documentation_path,
    Pattern::new(r"(?i)\.(?:md|mdx|markdown|txt|rst|adoc)$")
);
pattern!(ends_with_question, Pattern::new(r#"\?[\s*_`"')\]]*$"#));

#[derive(Debug, Clone, PartialEq)]
struct Change {
    path: Option<String>,
    step: f64,
    documentation: bool,
}

/// The name of a source or test file without its extension and test markers.
fn code_stem(path: &str) -> String {
    use fancy_regex::Regex;
    static MARKERS: OnceLock<[Regex; 4]> = OnceLock::new();
    let [extension, suffix, prefix, camel] = MARKERS.get_or_init(|| {
        [
            Regex::new(r"\.[^.]+$").expect("pattern"),
            Regex::new(r"(?i)[._-](?:test|tests|spec|specs)$").expect("pattern"),
            Regex::new(r"(?i)^(?:test|spec)[._-]").expect("pattern"),
            Regex::new(r"(?:Test|Tests|Spec|IT)$").expect("pattern"),
        ]
    });
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = extension.replace(name, "");
    let name = suffix.replace(&name, "");
    let name = prefix.replace(&name, "");
    camel.replace(&name, "").to_lowercase()
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/')
}

/// Whether the workspace-relative or absolute `file` is in the scope directory `dir`.
fn in_scope(file: &str, dir: &str, cwd: Option<&str>) -> bool {
    let scope = normalize_path(dir);
    let absolute_file = is_absolute(file);
    let absolute_scope = is_absolute(&scope);
    let within = |path: &str| path == scope || path.starts_with(&format!("{scope}/"));
    if absolute_file == absolute_scope {
        return within(file);
    }
    if absolute_file {
        return match cwd.and_then(|cwd| relative_to_root(file, cwd)) {
            Some(relative) => within(&relative),
            None => file.contains(&format!("/{scope}/")),
        };
    }
    let mut parts: Vec<&str> = file.split('/').collect();
    parts.pop();
    (1..=parts.len())
        .rev()
        .any(|length| scope.ends_with(&format!("/{}", parts[..length].join("/"))))
}

/// Whether `check` covers a change of `path`.
fn covers(check: &VerificationRecord, path: Option<&str>, cwd: Option<&str>) -> bool {
    let Some(path) = path else { return true };
    let file = normalize_path(&path.replace('\\', "/"));
    if let Some(scope) = &check.scope {
        if !scope.is_empty() && !scope.iter().any(|dir| in_scope(&file, dir, cwd)) {
            return false;
        }
    }
    match &check.files {
        None => true,
        Some(files) => {
            let stem = code_stem(&file);
            files.iter().any(|named| code_stem(named) == stem)
        }
    }
}

/// Tracks what the tool calls of one developer request actually did.
#[derive(Debug, Clone)]
pub struct EvidenceLedger {
    max_gates: usize,
    cwd: Option<String>,
    clock: f64,
    mutations: usize,
    opaque_effects: usize,
    changes: Vec<Change>,
    changed: Vec<String>,
    verifications: Vec<VerificationRecord>,
    action_requested: bool,
    gates: usize,
    last_report: Option<CompletionReport>,
}

impl EvidenceLedger {
    pub fn new(max_gates_per_request: usize, cwd: Option<String>) -> Self {
        Self {
            max_gates: max_gates_per_request,
            cwd,
            clock: 0.0,
            mutations: 0,
            opaque_effects: 0,
            changes: Vec::new(),
            changed: Vec::new(),
            verifications: Vec::new(),
            action_requested: false,
            gates: 0,
            last_report: None,
        }
    }

    pub fn begin_request(&mut self, action_requested: bool) {
        let max_gates = self.max_gates;
        let cwd = self.cwd.take();
        *self = Self::new(max_gates, cwd);
        self.action_requested = action_requested;
    }

    /// A tool call starts; returns its start time for [`record_tool_outcome`](Self::record_tool_outcome).
    pub fn begin_tool_call(&mut self) -> f64 {
        let now = self.clock;
        self.clock += 1.0;
        now
    }

    /// Record the outcome of an executed tool call. Without `started_at` the call starts now.
    pub fn record_tool_outcome(
        &mut self,
        effect: &ToolEffect,
        is_error: bool,
        output: &str,
        started_at: Option<f64>,
    ) {
        let started_at = started_at.unwrap_or_else(|| self.begin_tool_call());
        let ended_at = self.clock;
        self.clock += 1.0;
        if is_mutation(effect.kind) && !is_error {
            self.record(&effect.paths, ended_at);
        }
        if let Some(writes) = &effect.writes {
            if !is_error || effect.kind == ToolEffectKind::Verify {
                let step = if effect.kind == ToolEffectKind::Verify {
                    started_at
                } else {
                    ended_at
                };
                self.record(writes, step);
            }
        }
        if effect.kind == ToolEffectKind::Execute && !is_error {
            self.opaque_effects += 1;
        }
        if effect.kind == ToolEffectKind::Verify {
            let command = effect.command.clone().unwrap_or_default();
            let empty = !is_error && empty_run().test(output);
            self.verifications.push(VerificationRecord {
                command: clip(&command, 120),
                passed: !is_error && !empty,
                step: if effect.writes.is_some() {
                    started_at + 0.5
                } else {
                    started_at
                },
                name_filtered: name_filter().test(&command),
                empty,
                scope: effect.scope.clone(),
                files: effect.files.clone(),
            });
        }
    }

    fn record(&mut self, paths: &[String], step: f64) {
        self.mutations += 1;
        if paths.is_empty() {
            self.changes.push(Change {
                path: None,
                step,
                documentation: false,
            });
            return;
        }
        for path in paths {
            self.changes.push(Change {
                path: Some(path.clone()),
                step,
                documentation: documentation_path().test(path),
            });
            if !self.changed.contains(path) {
                self.changed.push(path.clone());
            }
        }
    }

    fn uncovered(&self) -> Vec<&Change> {
        self.changes
            .iter()
            .filter(|change| {
                !change.documentation
                    && !self.verifications.iter().any(|check| {
                        check.passed
                            && check.step > change.step
                            && covers(check, change.path.as_deref(), self.cwd.as_deref())
                    })
            })
            .collect()
    }

    /// Paths changed since a passing check that covers them, or None when every change is covered.
    pub fn pending_changes(&self) -> Option<Vec<String>> {
        let pending = self.uncovered();
        if pending.is_empty() {
            return None;
        }
        let mut seen = BTreeSet::new();
        let mut paths = Vec::new();
        for change in pending {
            let path = change
                .path
                .clone()
                .unwrap_or_else(|| "(shell command)".to_string());
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        Some(paths)
    }

    fn pending_detail(&self, pending: &[String]) -> String {
        let Some(last) = self.verifications.last() else {
            return "files changed and no test, type check, build, or lint command ran afterwards"
                .to_string();
        };
        if last.empty {
            return format!("the last check ran no tests (`{}`)", last.command);
        }
        if !last.passed {
            return format!(
                "files changed after the last check (`{}`, which failed)",
                last.command
            );
        }
        if self
            .uncovered()
            .iter()
            .any(|change| change.step > last.step)
        {
            return format!("files changed after the last check (`{}`)", last.command);
        }
        let scope = last
            .scope
            .as_ref()
            .map(|scope| scope.join(", "))
            .unwrap_or_else(|| "other files".to_string());
        format!(
            "the last check (`{}`) covers {scope}, not {}",
            last.command,
            pending
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    }

    /// Compare the final message of a turn with the recorded evidence.
    pub fn assess(&mut self, final_text: &str) -> CompletionReport {
        let pending = self.pending_changes();
        let explicit = completion_claim().test(final_text) || check_claim().test(final_text);
        let asks = ends_with_question().test(trim_js(final_text));
        let claimed = explicit || (pending.is_some() && !asks);
        let report = |status: CompletionStatus, detail: Option<String>| CompletionReport {
            status,
            claimed,
            changed_paths: self.changed.clone(),
            mutations: self.mutations,
            verifications: self.verifications.clone(),
            detail,
            gated: false,
        };
        let last_check = self.verifications.last();
        let result = if !claimed {
            match &pending {
                Some(pending) if asks => report(
                    CompletionStatus::Question,
                    Some(format!(
                        "the message asks a question while changes no passing check covers are pending: {}",
                        pending.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
                    )),
                ),
                _ => report(CompletionStatus::NoClaim, None),
            }
        } else if acknowledgement().test(final_text)
            || (past_failure().test(final_text) && last_check.is_some_and(|check| !check.passed))
        {
            report(CompletionStatus::Acknowledged, None)
        } else if all_tests_claim().test(final_text)
            && last_check.is_some_and(|check| check.passed && check.name_filtered)
        {
            let command = &last_check.expect("checked").command;
            report(
                CompletionStatus::Contradicted,
                Some(format!("the message says all tests pass, but the last check ran only tests matching a name filter: `{command}`")),
            )
        } else if check_claim().test(final_text) && last_check.is_none_or(|check| !check.passed) {
            let detail = match last_check {
                None => "the message says checks pass, but no test, type check, build, or lint command ran in this request".to_string(),
                Some(check) if check.empty => format!("the message says checks pass, but the last check ran no tests: `{}`", check.command),
                Some(check) => format!("the message says checks pass, but the last check failed: `{}`", check.command),
            };
            report(CompletionStatus::Contradicted, Some(detail))
        } else if self.mutations == 0 {
            if self.action_requested && self.opaque_effects == 0 {
                report(
                    CompletionStatus::NoEffect,
                    Some("the developer requested a change and the message reports it done, but the tool calls only read state".to_string()),
                )
            } else {
                report(CompletionStatus::NoClaim, None)
            }
        } else if let Some(pending) = &pending {
            report(
                CompletionStatus::Unverified,
                Some(self.pending_detail(pending)),
            )
        } else {
            report(CompletionStatus::Verified, None)
        };
        self.last_report = Some(result.clone());
        result
    }

    /// Whether a report should go back to the agent as a verification request. Consumes one gate.
    pub fn should_gate(&mut self, report: &mut CompletionReport) -> bool {
        if !report.status.is_flagged() || self.gates >= self.max_gates {
            return false;
        }
        self.gates += 1;
        report.gated = true;
        if let Some(last) = &mut self.last_report {
            last.gated = true;
        }
        true
    }

    pub fn latest_report(&self) -> Option<&CompletionReport> {
        self.last_report.as_ref()
    }
}

/// The verification request sent to the agent for a flagged report.
pub fn format_verification_request(
    report: &CompletionReport,
    verify_commands: &[String],
) -> String {
    let changed = report
        .changed_paths
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let how = if verify_commands.is_empty() {
        "run the project's verification for the changed code (tests, type check, or build) without piping its output, and report the actual result.".to_string()
    } else {
        format!(
            "run the project's verification ({}) without piping its output, and report the actual result.",
            verify_commands.iter().map(|command| format!("`{command}`")).collect::<Vec<_>>().join(", ")
        )
    };
    let mut lines = vec![format!(
        "[harness:evidence] Completion check: your last message reports the work as finished, but the harness has no evidence for it: {}.",
        report.detail.as_deref().unwrap_or("undefined")
    )];
    if !changed.is_empty() {
        lines.push(format!(
            "Changed in this request: {changed}{}.",
            if report.changed_paths.len() > 8 {
                ", ..."
            } else {
                ""
            }
        ));
    }
    lines.push(format!("Before reporting completion, {how}"));
    lines.push("If verification is not possible, say exactly what was not verified and why. Do not restate success without evidence.".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{classify_command, ClassifyContext};

    fn write(path: &str) -> ToolEffect {
        let mut effect = classify_command("", &[], &ClassifyContext::default());
        effect.kind = ToolEffectKind::Write;
        effect.command = None;
        effect.paths = vec![path.to_string()];
        effect
    }

    #[test]
    fn gates_unverified_work_and_accepts_a_covering_check() {
        let mut ledger = EvidenceLedger::new(1, None);
        ledger.begin_request(true);
        ledger.record_tool_outcome(&write("src/a.ts"), false, "", None);
        assert_eq!(ledger.assess("Done.").status, CompletionStatus::Unverified);
        let check = classify_command("npm test", &[], &ClassifyContext::default());
        ledger.record_tool_outcome(&check, false, "Tests 5 passed", None);
        assert_eq!(ledger.assess("Done.").status, CompletionStatus::Verified);
    }

    #[test]
    fn a_parallel_check_does_not_cover_an_edit_that_ended_after_it_started() {
        let mut ledger = EvidenceLedger::new(1, None);
        ledger.begin_request(true);
        let edit = ledger.begin_tool_call();
        let test = ledger.begin_tool_call();
        ledger.record_tool_outcome(&write("src/a.ts"), false, "", Some(edit));
        ledger.record_tool_outcome(
            &classify_command("npm test", &[], &ClassifyContext::default()),
            false,
            "ok",
            Some(test),
        );
        assert_eq!(ledger.assess("Done.").status, CompletionStatus::Unverified);
    }

    #[test]
    fn stems_test_files_like_their_modules() {
        assert_eq!(code_stem("test/config.test.ts"), "config");
        assert_eq!(code_stem("tests/test_config.py"), "config");
        assert_eq!(code_stem("src/ConfigTest.java"), "config");
    }
}
