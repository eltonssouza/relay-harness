//! Pillar 1: alignment with the developer. Port of `packages/agent/src/harness/alignment.ts`.
//!
//! The interactive authorizer of the TypeScript policy is asynchronous (a dialog). Here a check
//! that would ask it returns [`AlignmentDecision::AskAuthorizer`] with the operation's
//! fingerprint, and the runtime answers with [`AlignmentPolicy::resolve_authorization`].

use std::collections::BTreeSet;
use std::sync::OnceLock;

use crate::effects::{
    deletion_targets, requires_authorization, risky_operations, ClassifyContext, RiskyOperation,
    ToolEffect, ToolEffectKind,
};
use crate::text::{
    clip, developer_prose, js_length, phrase_pattern, split_by, trim_js, words_pattern,
    words_source, Pattern,
};

macro_rules! pattern {
    ($name:ident, $init:expr) => {
        fn $name() -> &'static Pattern {
            static CELL: OnceLock<Pattern> = OnceLock::new();
            CELL.get_or_init(|| $init)
        }
    };
}

// ============================================================================
// Constraint ledger
// ============================================================================

/// Where a constraint came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintSource {
    /// Extracted from a developer message.
    Message,
    /// Added programmatically.
    Api,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeveloperConstraint {
    pub id: String,
    pub text: String,
    pub source: ConstraintSource,
    pub timestamp: f64,
}

const DIRECTIVE_START_WORDS: &[&str] = &[
    "never", "avoid", "keep", "prefer", "stick to", "nunca", "jamais", "evite", "mantenha",
    "prefira",
];

pattern!(
    directive_start,
    Pattern::new(&format!(
        r"(?i)^(?:please\s+|por favor,?\s+)?{}",
        words_source(DIRECTIVE_START_WORDS)
    ))
);
pattern!(
    keep_going,
    Pattern::new(
        r"(?i)^(?:please\s+)?keep\s+(?:going|on|it up|at it|trying|working|up)(?![\p{L}])"
    )
);

const STATEMENT_WORDS: &[&str] = &[
    "consegui",
    "consigo",
    "conseguimos",
    "conseguiu",
    "pude",
    "posso",
    "sei",
    "vou",
    "vai",
    "estou",
    "está",
    "esta",
    "estava",
    "era",
    "foi",
    "tenho",
    "tem",
    "deu",
    "dá",
    "sabe",
];

const CONSTRAINED_VERBS: &[&str] = &[
    "use",
    "change",
    "modify",
    "touch",
    "edit",
    "commit",
    "push",
    "run",
    "add",
    "remove",
    "delete",
    "create",
    "install",
    "rename",
    "refactor",
    "call",
    "write",
    "break",
    "import",
    "update",
    "upgrade",
    "downgrade",
    "mock",
    "skip",
    "disable",
    "usar?",
    "altere",
    "alterar",
    "mude",
    "mudar",
    "mexa",
    "mexer",
    "toque",
    "tocar",
    "edite",
    "editar",
    "commite",
    "commitar",
    "faça",
    "fazer",
    "rode",
    "rodar",
    "execute",
    "executar",
    "adicione",
    "adicionar",
    "remova",
    "remover",
    "apague",
    "apagar",
    "deletar",
    "crie",
    "criar",
    "instale",
    "instalar",
    "renomeie",
    "renomear",
    "refatore",
    "refatorar",
    "chame",
    "chamar",
    "escreva",
    "escrever",
    "quebre",
    "quebrar",
    "importe",
    "importar",
    "atualize",
    "atualizar",
    "pule",
    "pular",
    "desative",
    "desativar",
];

const DIRECTIVE_INNER_LEAD: &[&str] = &[
    "do not",
    "don't",
    "dont",
    "never",
    "must not",
    "mustn't",
    "should not",
    "shouldn't",
    "only",
    "always",
    "não",
    "nao",
    "nunca",
    "jamais",
    "sempre",
    "apenas",
    "somente",
    "só",
];

pattern!(
    directive_inner,
    phrase_pattern(DIRECTIVE_INNER_LEAD, CONSTRAINED_VERBS, STATEMENT_WORDS)
);
pattern!(
    directive_preference,
    Pattern::new(&format!(
        r"(?i){}use\s+.{{1,60}}\s+(?:instead of|rather than|em vez de|ao invés de|no lugar de)(?![\p{{L}}])",
        crate::text::ASCII_B
    ))
);
pattern!(sentence_separator, Pattern::new(r"\n+|(?<=[.!;])\s+"));
pattern!(list_marker, Pattern::new(r"^\s*(?:[-*+]|\d+[.)])\s+"));

/// Extract standing constraints from developer prose.
pub fn extract_constraints(text: &str) -> Vec<String> {
    split_by(&developer_prose(text), sentence_separator())
        .into_iter()
        .map(|sentence| trim_js(&list_marker().regex().replace(&sentence, "")).to_string())
        .filter(|sentence| {
            let length = js_length(sentence);
            (8..=240).contains(&length) && !sentence.ends_with('?')
        })
        .filter(|sentence| {
            (directive_start().test(sentence) && !keep_going().test(sentence))
                || directive_inner().test(sentence)
                || directive_preference().test(sentence)
        })
        .collect()
}

/// Developer constraints kept as state, independent of the transcript and of compaction.
#[derive(Debug, Clone)]
pub struct ConstraintLedger {
    constraints: Vec<DeveloperConstraint>,
    next_id: u64,
    max_constraints: usize,
}

impl Default for ConstraintLedger {
    fn default() -> Self {
        Self::new(12)
    }
}

impl ConstraintLedger {
    pub fn new(max_constraints: usize) -> Self {
        Self {
            constraints: Vec::new(),
            next_id: 1,
            max_constraints,
        }
    }

    /// Extract and record the constraints stated in a developer message. Returns the new ones.
    pub fn observe_developer_text(
        &mut self,
        text: &str,
        timestamp: f64,
    ) -> Vec<DeveloperConstraint> {
        extract_constraints(text)
            .iter()
            .filter_map(|sentence| self.insert(sentence, ConstraintSource::Message, timestamp))
            .collect()
    }

    /// Record a constraint directly, e.g. from configuration or a slash command.
    pub fn add(&mut self, text: &str, timestamp: f64) -> Option<DeveloperConstraint> {
        self.insert(text, ConstraintSource::Api, timestamp)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.constraints.len();
        self.constraints.retain(|constraint| constraint.id != id);
        self.constraints.len() != before
    }

    pub fn clear(&mut self) {
        self.constraints.clear();
    }

    /// Replace the ledger with persisted constraints.
    pub fn restore(&mut self, constraints: &[DeveloperConstraint]) {
        let skip = constraints.len().saturating_sub(self.max_constraints);
        self.constraints = constraints[skip..].to_vec();
        let highest = self
            .constraints
            .iter()
            .filter_map(|constraint| {
                constraint
                    .id
                    .strip_prefix('c')
                    .unwrap_or(&constraint.id)
                    .parse::<u64>()
                    .ok()
            })
            .max()
            .unwrap_or(0);
        self.next_id = highest + 1;
    }

    pub fn list(&self) -> &[DeveloperConstraint] {
        &self.constraints
    }

    fn insert(
        &mut self,
        text: &str,
        source: ConstraintSource,
        timestamp: f64,
    ) -> Option<DeveloperConstraint> {
        let normalized = clip(text, 240);
        let key = normalized.to_lowercase();
        if normalized.is_empty()
            || self
                .constraints
                .iter()
                .any(|constraint| constraint.text.to_lowercase() == key)
        {
            return None;
        }
        let constraint = DeveloperConstraint {
            id: format!("c{}", self.next_id),
            text: normalized,
            source,
            timestamp,
        };
        self.next_id += 1;
        self.constraints.push(constraint.clone());
        if self.constraints.len() > self.max_constraints {
            self.constraints.remove(0);
        }
        Some(constraint)
    }
}

// ============================================================================
// Intent: questions versus requests
// ============================================================================

const INTERROGATIVE_WORDS: &[&str] = &[
    "why",
    "how",
    "what",
    "where",
    "which",
    "who",
    "when",
    "could you explain",
    "can you explain",
    "explain",
    "por que",
    "porque",
    "por quê",
    "como",
    "qual",
    "quais",
    "onde",
    "quando",
    "quem",
    "o que",
    "existe",
    "será",
    "sera",
    "explique",
    "me explique",
];

const ACTION_WORDS: &[&str] = &[
    "fix",
    "implement",
    "add",
    "change",
    "update",
    "refactor",
    "create",
    "write",
    "remove",
    "delete",
    "rename",
    "make",
    "build",
    "run",
    "apply",
    "edit",
    "move",
    "replace",
    "upgrade",
    "install",
    "migrate",
    "commit",
    "push",
    "corrija",
    "conserte",
    "corrigir",
    "implemente",
    "implementar",
    "adicione",
    "adicionar",
    "altere",
    "alterar",
    "mude",
    "mudar",
    "atualize",
    "atualizar",
    "refatore",
    "refatorar",
    "crie",
    "criar",
    "escreva",
    "escrever",
    "remova",
    "remover",
    "apague",
    "apagar",
    "renomeie",
    "renomear",
    "faça",
    "fazer",
    "aplique",
    "aplicar",
    "rode",
    "rodar",
    "execute",
    "executar",
    "edite",
    "editar",
    "mova",
    "mover",
    "substitua",
    "substituir",
    "instale",
    "instalar",
    "migre",
    "migrar",
    "commite",
    "commitar",
    "melhore",
    "melhorar",
    "improve",
];

const KNOWN_LANGUAGE_WORDS: &[&str] = &[
    "the", "is", "are", "this", "that", "it", "why", "how", "what", "does", "you", "can", "please",
    "não", "nao", "você", "voce", "isso", "esse", "essa", "uma", "também", "são", "pelo", "pela",
    "por que", "porque", "por quê", "como", "onde", "quando", "quem", "teste", "testes", "código",
    "função", "qual", "quais",
];

const REQUEST_MARKER_WORDS: &[&str] = &[
    "can you",
    "could you",
    "would you",
    "please",
    "let's",
    "lets",
    "pode",
    "poderia",
    "consegue",
    "por favor",
    "vamos",
];

pattern!(
    interrogative_start,
    Pattern::new(&format!("(?i)^{}", words_source(INTERROGATIVE_WORDS)))
);
pattern!(action_request, words_pattern(ACTION_WORDS));
pattern!(
    imperative_sentence,
    Pattern::new(&format!(
        r"(?i)^\s*(?:please\s+|por favor,?\s+|also\s+|then\s+|e\s+|depois\s+)?(?:{})(?![\p{{L}}\p{{N}}_])",
        ACTION_WORDS.join("|")
    ))
);
pattern!(known_language, words_pattern(KNOWN_LANGUAGE_WORDS));
pattern!(request_marker, words_pattern(REQUEST_MARKER_WORDS));
pattern!(question_separator, Pattern::new(r"(?<=[.!?])\s+|\n+"));

/// Whether a developer message asks only a question, without requesting a change.
pub fn is_question_only(text: &str) -> bool {
    let prose = developer_prose(text);
    if prose.is_empty() || !known_language().test(&prose) {
        return false;
    }
    let sentences: Vec<String> = split_by(&prose, question_separator())
        .into_iter()
        .filter(|sentence| !trim_js(sentence).is_empty())
        .collect();
    if sentences
        .iter()
        .skip(1)
        .any(|sentence| imperative_sentence().test(sentence))
    {
        return false;
    }
    let explanatory = interrogative_start().test(&prose);
    if !explanatory && !prose.ends_with('?') {
        return false;
    }
    if explanatory && !request_marker().test(&prose) {
        return true;
    }
    !action_request().test(&prose)
}

/// Whether a developer message requests a change.
pub fn requests_action(text: &str) -> bool {
    action_request().test(&developer_prose(text))
}

// ============================================================================
// Pair programming: corrections
// ============================================================================

/// Collaboration rules for the system prompt.
pub const PAIR_PROGRAMMING_GUIDELINES: &[&str] = &[
    "The developer owns the what and the why; you own the how. If the goal or the reason behind a request is unclear, ask before building",
    "Prefer the simplest design that meets the stated requirements; propose a more complex one only by naming the requirement that needs it",
    "Treat context the developer gives about their environment, services, or domain as authoritative over your assumptions, even when it contradicts common practice",
];

pattern!(
    correction_start,
    Pattern::new(concat!(
        r"(?i)^(?:no|nope|não|nao|para|pare|espera|wait|stop|hold on)\s*[,.!;:—]",
        "|",
        r"^(?:wrong|that's wrong|not that|actually|instead|undo|revert|simplify|errado|errada|não é isso|na verdade|em vez disso|ao invés disso|desfaz|desfaça|volta|simplifica|simplifique)(?![\p{L}])"
    ))
);
pattern!(
    correction_anywhere,
    words_pattern(&[
        "too (?:complex|complicated|much)",
        "over-?engineer(?:ed|ing)?",
        "(?:that's|this is|that is) not what I",
        "complicad[oa] demais",
        "muito complicad[oa]",
        "não (?:é|era) (?:isso|o que eu)",
        "simplifica",
        "simplifique",
    ])
);

/// Whether a developer message corrects the agent's previous approach.
pub fn is_correction(text: &str) -> bool {
    let prose = developer_prose(text);
    correction_start().test(&prose) || correction_anywhere().test(&prose)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeveloperCorrection {
    pub text: String,
    pub timestamp: f64,
}

// ============================================================================
// Authorization gate
// ============================================================================

fn escape(text: &str) -> String {
    let mut escaped = String::new();
    for char in text.chars() {
        if ".*+?^${}()|[]\\".contains(char) {
            escaped.push('\\');
        }
        escaped.push(char);
    }
    escaped
}

/// Whether `request` names `path` exactly, as a whole path.
fn names_path(request: &str, path: &str) -> bool {
    Pattern::new(&format!(
        r"(?<![\p{{L}}\p{{N}}_./-]){}(?![\p{{L}}\p{{N}}_-]|[/.][\p{{L}}\p{{N}}_])",
        escape(&path.to_lowercase())
    ))
    .test(request)
}

/// Whether `request` names the file at `path`, by any trailing part of it.
fn names_file(request: &str, path: &str) -> bool {
    let lower = path.replace('\\', "/").to_lowercase();
    let parts: Vec<&str> = lower.split('/').filter(|part| !part.is_empty()).collect();
    (0..parts.len()).any(|index| names_path(request, &parts[index..].join("/")))
}

pattern!(
    delete_request,
    words_pattern(&[
        "delete", "remove", "rm", "clean", "drop", "wipe", "apague", "apagar", "remova", "remover",
        "exclua", "excluir", "limpe", "limpar"
    ])
);
pattern!(
    push_request,
    words_pattern(&["push", "pushe", "faça push", "dê push"])
);
pattern!(
    force_push_request,
    words_pattern(&[
        "force push",
        "force-push",
        "push --force",
        "push -f",
        "forçar o push",
        "push forçado"
    ])
);
pattern!(
    reset_request,
    words_pattern(&[
        "git reset",
        "reset --hard",
        "hard reset",
        "reset hard",
        "reset (?:the |o )?(?:branch|head|repo|repository|repositório)",
        "resete o (?:branch|repositório)",
        "resetar o (?:branch|repositório)",
    ])
);
pattern!(rebase_request, words_pattern(&["rebase"]));
pattern!(
    publish_request,
    words_pattern(&["publish", "publique", "publicar"])
);
pattern!(
    deploy_request,
    words_pattern(&["deploy", "implante", "implantar", "ship"])
);
pattern!(
    github_request,
    phrase_pattern(
        &[
            "create", "open", "close", "comment", "post", "crie", "criar", "abra", "abrir",
            "feche", "fechar", "comente", "comentar"
        ],
        &["pr", "pull request", "issue", "release", "repo"],
        &[]
    )
);
pattern!(
    merge_request,
    phrase_pattern(
        &[
            "merge",
            "mergear",
            "mergeie",
            "mescle",
            "mesclar",
            "faça o merge",
            "faça merge",
            "dê merge"
        ],
        &["pr", "pull request", r"#\d+"],
        &[]
    )
);
pattern!(
    docker_push_request,
    words_pattern(&[
        "docker push",
        "push (?:the |an? )?image",
        "push (?:da |a )?imagem",
        "envie a imagem",
        "publique a imagem"
    ])
);
pattern!(
    infra_command,
    Pattern::new(&format!(
        r"{b}(?:kubectl\s+(?:apply|delete|scale|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy)){b}",
        b = crate::text::ASCII_B
    ))
);

/// How the developer's latest request authorizes each risky operation it names. None: never.
fn mentions(operation: RiskyOperation, request: &str, command: &str) -> bool {
    use RiskyOperation as Op;
    match operation {
        Op::GitPush => push_request().test(request),
        Op::GitForcePush => force_push_request().test(request),
        Op::GitReset => reset_request().test(request),
        Op::GitRebase => rebase_request().test(request),
        Op::Delete => {
            delete_request().test(request)
                && deletion_targets(command)
                    .is_some_and(|targets| targets.iter().all(|target| names_path(request, target)))
        }
        Op::Publish => publish_request().test(request),
        Op::Deploy => deploy_request().test(request),
        Op::Github => github_request().test(request),
        Op::GithubMerge => merge_request().test(request),
        Op::DockerPush => docker_push_request().test(request),
        Op::Infra => {
            let changes: Vec<String> = infra_command()
                .regex()
                .find_iter(command)
                .flatten()
                .map(|found| {
                    found
                        .as_str()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase()
                })
                .collect();
            !changes.is_empty()
                && changes
                    .iter()
                    .all(|change| request.contains(change.as_str()))
        }
        _ => false,
    }
}

pattern!(
    affirmative,
    Pattern::new(&format!(
        r"(?i)^\s*{}",
        words_source(&[
            "y",
            "yes",
            "yep",
            "yeah",
            "sure",
            "ok",
            "okay",
            "go ahead",
            "proceed",
            "do it",
            "confirm",
            "confirmed",
            "approve",
            "approved",
            "sim",
            "s",
            "pode (?:sim|rodar|executar|seguir|continuar|fazer|mandar|ir|apagar|prosseguir)",
            "vai em frente",
            "manda ver",
            "confirmo",
            "autorizo",
            "prossiga",
            "faça isso",
            "faca isso",
            "isso mesmo",
        ])
    ))
);
pattern!(
    bare_approval,
    Pattern::new(r"(?i)^\s*(?:pode|vai|isso|manda|faça|faca)\s*[.!]*\s*$")
);
pattern!(
    question_words,
    words_pattern(&[
        "what", "why", "how", "which", "where", "when", "who", "explain", "o que", "o quê",
        "por que", "porque", "por quê", "como", "qual", "quais", "onde", "quando", "quem",
        "explica", "explique",
    ])
);
pattern!(
    reservation,
    words_pattern(&[
        "no", "not", "don't", "dont", "never", "but", "não", "nao", "nunca", "mas", "porém",
        "porem", "exceto", "except"
    ])
);
pattern!(
    clause_separator,
    Pattern::new(r"\.(?=\s|$)|[,;!?\n]|(?<![\p{L}])(?:but|mas|porém|porem)(?![\p{L}])")
);
pattern!(leading_dot_slash, Pattern::new(r"(^|\s)(?:\./)+"));

/// Whether a developer's reply approves the operations waiting for an answer.
fn approves_pending(text: &str) -> bool {
    let prose = developer_prose(text);
    if prose.contains('?') || question_words().test(&prose) || reservation().test(&prose) {
        return false;
    }
    if prose.split_whitespace().count() > 8 {
        return false;
    }
    affirmative().test(&prose) || bare_approval().test(&prose)
}

/// Stable identity of an operation, used for one-shot grants.
pub fn fingerprint(tool_name: &str, effect: &ToolEffect) -> String {
    let subject = effect
        .command
        .clone()
        .unwrap_or_else(|| effect.paths.join(","));
    format!(
        "{tool_name}:{}",
        trim_js(&subject.split_whitespace().collect::<Vec<_>>().join(" "))
    )
}

/// How a call was allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowedVia {
    Request,
    Grant,
    Authorizer,
}

impl AllowedVia {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Grant => "grant",
            Self::Authorizer => "authorizer",
        }
    }
}

/// Why a call was blocked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Authorization,
    Scope,
}

impl BlockKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authorization => "authorization",
            Self::Scope => "scope",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlignmentDecision {
    Allow {
        via: Option<AllowedVia>,
    },
    Block {
        reason: String,
        kind: BlockKind,
    },
    /// The interactive authorizer must be asked; answer with [`AlignmentPolicy::resolve_authorization`].
    AskAuthorizer {
        fingerprint: String,
    },
}

#[derive(Debug, Clone)]
pub struct AlignmentPolicyOptions {
    pub max_constraints: usize,
    /// Whether an interactive authorizer exists. Without one, risky calls are blocked until the developer approves in chat.
    pub has_authorizer: bool,
    pub scope_guard: bool,
    pub authorization_gate: bool,
}

impl Default for AlignmentPolicyOptions {
    fn default() -> Self {
        Self {
            max_constraints: 12,
            has_authorizer: false,
            scope_guard: true,
            authorization_gate: true,
        }
    }
}

/// Alignment state and checks for one agent.
#[derive(Debug, Clone)]
pub struct AlignmentPolicy {
    pub constraints: ConstraintLedger,
    options: AlignmentPolicyOptions,
    latest_request: String,
    question_only: bool,
    scope_warned: bool,
    pending: BTreeSet<String>,
    grants: BTreeSet<String>,
    corrections: Vec<DeveloperCorrection>,
    correcting: bool,
}

impl AlignmentPolicy {
    pub fn new(options: AlignmentPolicyOptions) -> Self {
        Self {
            constraints: ConstraintLedger::new(options.max_constraints),
            options,
            latest_request: String::new(),
            question_only: false,
            scope_warned: false,
            pending: BTreeSet::new(),
            grants: BTreeSet::new(),
            corrections: Vec::new(),
            correcting: false,
        }
    }

    /// Observe a developer message: record constraints, intent, corrections, and answers to pending
    /// authorizations. Returns whether the message recorded a correction.
    pub fn observe_developer_message(
        &mut self,
        text: &str,
        timestamp: f64,
        after_agent_work: bool,
    ) -> bool {
        self.constraints.observe_developer_text(text, timestamp);
        self.latest_request = developer_prose(text);
        self.question_only = is_question_only(text);
        self.scope_warned = false;
        self.correcting = after_agent_work && is_correction(text);
        if self.correcting {
            self.corrections.push(DeveloperCorrection {
                text: clip(&self.latest_request, 240),
                timestamp,
            });
            if self.corrections.len() > 12 {
                self.corrections.remove(0);
            }
        }
        if !self.pending.is_empty() && approves_pending(text) {
            self.grants.extend(self.pending.iter().cloned());
        }
        self.pending.clear();
        self.correcting
    }

    /// Drop state that belongs to the conversation as it was.
    pub fn reset_conversation_state(&mut self) {
        self.pending.clear();
        self.grants.clear();
        self.latest_request.clear();
        self.question_only = false;
        self.scope_warned = false;
        self.correcting = false;
    }

    pub fn pending_authorizations(&self) -> Vec<String> {
        self.pending.iter().cloned().collect()
    }

    pub fn corrections(&self) -> &[DeveloperCorrection] {
        &self.corrections
    }

    pub fn restore_corrections(&mut self, corrections: &[DeveloperCorrection]) {
        let skip = corrections.len().saturating_sub(12);
        self.corrections = corrections[skip..].to_vec();
    }

    pub fn render_correction(&self) -> Option<&'static str> {
        self.correcting.then_some(
            "The developer's latest message corrects your previous approach. Adopt the correction as stated, prefer the simplest design that satisfies it, and do not reintroduce what they rejected.",
        )
    }

    pub fn render_constraints(&self) -> Option<String> {
        let constraints = self.constraints.list();
        if constraints.is_empty() {
            return None;
        }
        let mut lines =
            vec!["Developer constraints in force (stated earlier; they still apply):".to_string()];
        lines.extend(
            constraints
                .iter()
                .map(|constraint| format!("- {}", constraint.text)),
        );
        Some(lines.join("\n"))
    }

    /// Decide whether a tool call may run.
    pub fn check(&mut self, tool_name: &str, effect: &ToolEffect) -> AlignmentDecision {
        if self.options.authorization_gate && requires_authorization(effect.kind) {
            return self.check_authorization(tool_name, effect);
        }
        let edits = effect.kind == ToolEffectKind::Write || effect.writes.is_some();
        if self.options.scope_guard && self.question_only && !self.scope_warned && edits {
            self.scope_warned = true;
            return AlignmentDecision::Block {
                kind: BlockKind::Scope,
                reason: concat!(
                    "Blocked by the harness alignment policy: the developer asked a question and did not request changes. ",
                    "Answer the question first, propose the change, and wait for approval. ",
                    "If you are certain the developer's message requests this change, you may retry the call."
                )
                .to_string(),
            };
        }
        AlignmentDecision::Allow { via: None }
    }

    /// The interactive authorizer's answer for a call that returned [`AlignmentDecision::AskAuthorizer`]:
    /// `Some(true)` allows it once, `Some(false)` declines, `None` means nobody could be asked.
    pub fn resolve_authorization(
        &mut self,
        effect: &ToolEffect,
        fingerprint: &str,
        approved: Option<bool>,
    ) -> AlignmentDecision {
        match approved {
            Some(true) => AlignmentDecision::Allow { via: Some(AllowedVia::Authorizer) },
            Some(false) => AlignmentDecision::Block {
                kind: BlockKind::Authorization,
                reason: format!(
                    "Blocked: the developer declined this {} operation ({}). Do not retry it; continue without it or ask how to proceed.",
                    effect.kind.as_str(),
                    effect.reason.as_deref().unwrap_or("unspecified effect")
                ),
            },
            None => {
                self.pending.insert(fingerprint.to_string());
                let command = effect.command.as_deref().unwrap_or("");
                let subject = if command.is_empty() { fingerprint.split(':').next().unwrap_or("") } else { command };
                AlignmentDecision::Block {
                    kind: BlockKind::Authorization,
                    reason: format!(
                        "Blocked by the harness alignment policy: `{}` is a {} operation ({}) and the developer has not authorized it. Explain what it would do and ask the developer to confirm. If they confirm, retry the same call unchanged.",
                        clip(subject, 160),
                        effect.kind.as_str(),
                        effect.reason.as_deref().unwrap_or("unspecified effect")
                    ),
                }
            }
        }
    }

    fn check_authorization(&mut self, tool_name: &str, effect: &ToolEffect) -> AlignmentDecision {
        let operation = fingerprint(tool_name, effect);
        if self.grants.remove(&operation) {
            return AlignmentDecision::Allow {
                via: Some(AllowedVia::Grant),
            };
        }
        let command = effect.command.as_deref().unwrap_or("");
        let lowered = self.latest_request.to_lowercase().replace('\\', "/");
        let clauses: Vec<String> = split_by(&lowered, clause_separator())
            .into_iter()
            .filter(|clause| !reservation().test(clause))
            .collect();
        let request = leading_dot_slash()
            .regex()
            .replace_all(&clauses.join(" . "), "$1")
            .into_owned();
        let operations = if command.is_empty() {
            Vec::new()
        } else {
            risky_operations(command, &ClassifyContext::default())
        };
        if !operations.is_empty()
            && operations
                .iter()
                .all(|risky| mentions(*risky, &request, command))
        {
            return AlignmentDecision::Allow {
                via: Some(AllowedVia::Request),
            };
        }
        let names_target = command.is_empty()
            && !effect.paths.is_empty()
            && effect.paths.iter().all(|path| names_file(&request, path));
        if names_target {
            return AlignmentDecision::Allow {
                via: Some(AllowedVia::Request),
            };
        }
        if self.options.has_authorizer {
            return AlignmentDecision::AskAuthorizer {
                fingerprint: operation,
            };
        }
        self.resolve_authorization(effect, &operation, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::classify_command;

    fn effect(command: &str) -> ToolEffect {
        classify_command(command, &[], &ClassifyContext::default())
    }

    #[test]
    fn authorizes_only_what_the_request_names() {
        let mut policy = AlignmentPolicy::new(AlignmentPolicyOptions::default());
        policy.observe_developer_message("push the branch", 0.0, true);
        assert_eq!(
            policy.check("bash", &effect("git push origin feature/x")),
            AlignmentDecision::Allow {
                via: Some(AllowedVia::Request)
            }
        );
        assert!(matches!(
            policy.check("bash", &effect("git push && git reset --hard HEAD~5")),
            AlignmentDecision::Block { .. }
        ));
    }

    #[test]
    fn does_not_take_a_question_as_approval() {
        let mut policy = AlignmentPolicy::new(AlignmentPolicyOptions::default());
        policy.observe_developer_message("Tidy the workspace", 0.0, true);
        let remove = effect("rm -rf build");
        assert!(matches!(
            policy.check("bash", &remove),
            AlignmentDecision::Block { .. }
        ));
        policy.observe_developer_message("Isso vai apagar o quê?", 1.0, true);
        assert!(matches!(
            policy.check("bash", &remove),
            AlignmentDecision::Block { .. }
        ));
        policy.observe_developer_message("sim", 2.0, true);
        assert_eq!(
            policy.check("bash", &remove),
            AlignmentDecision::Allow {
                via: Some(AllowedVia::Grant)
            }
        );
    }

    #[test]
    fn extracts_constraints() {
        assert_eq!(
            extract_constraints("Refactor the parser. Never use any in the new code.\nNão altere os testes existentes.\nKeep going."),
            ["Never use any in the new code.", "Não altere os testes existentes."]
        );
    }
}
