//! Tool effect classification shared by the harness pillars. Port of
//! `packages/agent/src/harness/effects.ts`.
//!
//! Shell commands are classified in two ways. Destructive and external effects match text, so a
//! command that only mentions an operation (`echo "git push"`) also matches: a false positive costs
//! one authorization prompt, a false negative could cost unrecoverable work. Verification is the
//! opposite: it is evidence, so it is recognized only by the program a command runs.
//!
//! Patterns run on bytes with Unicode off, so `\b`, `\w` and `\s` are ASCII as in JavaScript. The
//! Rust `regex` crate has no lookaround; the four rules that use it in TypeScript check the rest of
//! the line in code instead (`accept`), with the same result.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::bytes::{Regex, RegexBuilder};

use crate::shell::{parse_shell, program_name, ShellCommand};

/// What a tool call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolEffectKind {
    /// Observes state (files, search, listings).
    Read,
    /// Changes local working state in a reversible way (edit, write a file).
    Write,
    /// Runs a command whose effect is not otherwise known.
    Execute,
    /// Runs a check whose outcome is evidence (tests, type check, build, lint).
    Verify,
    /// Changes local state in a way that is hard to reverse.
    Destructive,
    /// Changes state outside the workspace or runs code on the developer's behalf elsewhere.
    External,
}

impl ToolEffectKind {
    /// The name the TypeScript implementation uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Execute => "execute",
            Self::Verify => "verify",
            Self::Destructive => "destructive",
            Self::External => "external",
        }
    }
}

/// The operation a risky command performs, so authorization can ask whether the developer named
/// each one: `git push && git reset --hard` performs two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RiskyOperation {
    GitPush,
    GitForcePush,
    GitReset,
    GitDiscard,
    GitBranchDelete,
    GitHistory,
    GitRebase,
    Delete,
    Permission,
    Disk,
    Sql,
    Eval,
    DownloadExec,
    Publish,
    Github,
    GithubMerge,
    Infra,
    DockerPush,
    DockerDelete,
    Deploy,
    RemoteWrite,
    ConfigWrite,
    RemoteCopy,
    MoveOut,
    InlineCode,
}

impl RiskyOperation {
    /// The name the TypeScript implementation uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitPush => "git-push",
            Self::GitForcePush => "git-force-push",
            Self::GitReset => "git-reset",
            Self::GitDiscard => "git-discard",
            Self::GitBranchDelete => "git-branch-delete",
            Self::GitHistory => "git-history",
            Self::GitRebase => "git-rebase",
            Self::Delete => "delete",
            Self::Permission => "permission",
            Self::Disk => "disk",
            Self::Sql => "sql",
            Self::Eval => "eval",
            Self::DownloadExec => "download-exec",
            Self::Publish => "publish",
            Self::Github => "github",
            Self::GithubMerge => "github-merge",
            Self::Infra => "infra",
            Self::DockerPush => "docker-push",
            Self::DockerDelete => "docker-delete",
            Self::Deploy => "deploy",
            Self::RemoteWrite => "remote-write",
            Self::ConfigWrite => "config-write",
            Self::RemoteCopy => "remote-copy",
            Self::MoveOut => "move-out",
            Self::InlineCode => "inline-code",
        }
    }
}

/// What a tool call does to the world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEffect {
    pub kind: ToolEffectKind,
    /// Workspace paths the call reads or writes, as given in the arguments.
    pub paths: Vec<String>,
    /// Shell command, for shell tools.
    pub command: Option<String>,
    /// Why a destructive or external classification was made.
    pub reason: Option<String>,
    /// For `Verify`: directories the check covers; absent when it covers the whole workspace.
    pub scope: Option<Vec<String>>,
    /// For `Verify`: the source and test files the check names.
    pub files: Option<Vec<String>>,
    /// For shell commands: workspace files the command modifies; empty when it edits files it does not name.
    pub writes: Option<Vec<String>>,
}

impl ToolEffect {
    fn new(kind: ToolEffectKind) -> Self {
        Self {
            kind,
            paths: Vec::new(),
            command: None,
            reason: None,
            scope: None,
            files: None,
            writes: None,
        }
    }
}

/// Where the session runs, so paths can be judged against the workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClassifyContext {
    /// Workspace root. Without it, no path counts as outside the workspace.
    pub cwd: Option<String>,
    /// Home directory, for `~` paths.
    pub home: Option<String>,
    /// The system temporary directory (`os.tmpdir()`).
    pub temp_dir: Option<String>,
}

/// A tool call: its tool name and its JSON arguments, reduced to the string arguments the
/// classification reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Vec<(String, String)>,
}

impl ToolCall {
    fn string_arg(&self, keys: &[&str]) -> Option<&str> {
        keys.iter().find_map(|key| {
            self.arguments
                .iter()
                .find(|(name, value)| name == key && !value.is_empty())
                .map(|(_, value)| value.as_str())
        })
    }
}

fn regex(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .unicode(false)
        .build()
        .expect("valid harness pattern")
}

fn regex_i(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .unicode(false)
        .case_insensitive(true)
        .build()
        .expect("valid harness pattern")
}

struct CommandRule {
    pattern: Regex,
    kind: ToolEffectKind,
    reason: &'static str,
    operation: RiskyOperation,
    /// For rules that need lookaround in TypeScript: whether a match is accepted, given the bytes after it.
    accept: Option<fn(&[u8]) -> bool>,
}

impl CommandRule {
    fn matches(&self, command: &[u8]) -> bool {
        match self.accept {
            None => self.pattern.is_match(command),
            Some(accept) => self
                .pattern
                .find_iter(command)
                .any(|found| accept(&command[found.end()..])),
        }
    }
}

/// `git` with its global options (`-C dir`, `--no-pager`, `--git-dir=x`) before the subcommand.
const GIT: &str = r"\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+";

fn rule(
    pattern: &str,
    kind: ToolEffectKind,
    reason: &'static str,
    operation: RiskyOperation,
) -> CommandRule {
    CommandRule {
        pattern: regex(pattern),
        kind,
        reason,
        operation,
        accept: None,
    }
}

fn rule_i(
    pattern: &str,
    kind: ToolEffectKind,
    reason: &'static str,
    operation: RiskyOperation,
) -> CommandRule {
    CommandRule {
        pattern: regex_i(pattern),
        kind,
        reason,
        operation,
        accept: None,
    }
}

fn starts_with_pattern(pattern: &'static str) -> &'static Regex {
    static CACHE: OnceLock<std::sync::Mutex<Vec<(&'static str, &'static Regex)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let mut entries = cache.lock().expect("pattern cache");
    if let Some((_, compiled)) = entries.iter().find(|(source, _)| *source == pattern) {
        return compiled;
    }
    let compiled: &'static Regex = Box::leak(Box::new(regex(pattern)));
    entries.push((pattern, compiled));
    compiled
}

fn restore_accept(rest: &[u8]) -> bool {
    // `restore\b(?:(?!X)|(?=Y))`: anything but a staged-only restore.
    let staged = starts_with_pattern(r"^[^\n;&|]*\s(?:--staged|-S)(?:\s|$)");
    let worktree = starts_with_pattern(r"^[^\n;&|]*\s(?:--worktree|-W)(?:\s|$)");
    !staged.is_match(rest) || worktree.is_match(rest)
}

fn rebase_accept(rest: &[u8]) -> bool {
    !starts_with_pattern(r"^\s+--(?:continue|abort|skip|quit)\b").is_match(rest)
}

fn deploy_script_accept(rest: &[u8]) -> bool {
    !starts_with_pattern(r"^[^\n;&|]*--dry-run").is_match(rest)
}

fn command_rules() -> &'static [CommandRule] {
    use RiskyOperation as Op;
    use ToolEffectKind::{Destructive, External};
    static RULES: OnceLock<Vec<CommandRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let git = |rest: &str| format!("{GIT}{rest}");
        vec![
            rule(
                &git(r"push\b[^\n;&|]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)"),
                Destructive,
                "force push rewrites remote history",
                Op::GitForcePush,
            ),
            rule(&git(r"reset\s+[^\n;&|]*--hard\b"), Destructive, "git reset --hard discards uncommitted work", Op::GitReset),
            rule(&git(r"clean\s+[^\n;&|]*-[a-zA-Z]*f"), Destructive, "git clean -f deletes untracked files", Op::GitDiscard),
            rule(
                &git(r"checkout\b(?:[^\n;&|]*?\s--\s+[^\s;&|]|[^\n;&|]*?\s(?:-f|--force)(?:\s|$)|(?:[^\n;&|]*?\s)?\.(?:\s|$))"),
                Destructive,
                "git checkout of paths or with --force overwrites uncommitted changes",
                Op::GitDiscard,
            ),
            CommandRule {
                pattern: regex(&git(r"restore\b")),
                kind: Destructive,
                reason: "git restore overwrites uncommitted changes in the working tree",
                operation: Op::GitDiscard,
                accept: Some(restore_accept),
            },
            rule(&git(r"stash\s+(?:drop|clear)\b"), Destructive, "git stash drop/clear deletes stashed work", Op::GitDiscard),
            rule(&git(r"branch\s+[^\n;&|]*-D\b"), Destructive, "git branch -D deletes an unmerged branch", Op::GitBranchDelete),
            rule(&git(r"(?:filter-branch|filter-repo)\b"), Destructive, "history rewrite", Op::GitHistory),
            CommandRule {
                pattern: regex(&git(r"rebase\b")),
                kind: Destructive,
                reason: "rebase rewrites history",
                operation: Op::GitRebase,
                accept: Some(rebase_accept),
            },
            rule(r"\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b", Destructive, "recursive delete", Op::Delete),
            rule(r"\brm\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b", Destructive, "forced delete", Op::Delete),
            rule(r"\b(?:unlink|shred)\s", Destructive, "irreversible delete", Op::Delete),
            rule_i(r"\bRemove-Item\b[^\n;|]*-Recurse\b", Destructive, "recursive delete", Op::Delete),
            rule_i(r"\b(?:rmdir|rd)\s+/s\b", Destructive, "recursive delete", Op::Delete),
            rule_i(r"\bdel\s+[^\n;&|]*/s\b", Destructive, "recursive delete", Op::Delete),
            rule_i(r"\b(?:rm|del|erase|Remove-Item)\s[^\n;&|]*?[^\s;&|]*[*?]", Destructive, "deletes the files a wildcard matches", Op::Delete),
            rule(r"\bfind\b[^\n;&|]*\s-delete\b", Destructive, "find -delete", Op::Delete),
            rule(r"\bfind\b[^\n]*-exec(?:dir)?\s+(?:rm|unlink|shred)\b", Destructive, "find -exec deletes what it finds", Op::Delete),
            rule(r"\bxargs\b[^\n;&|]*\b(?:rm|unlink|shred)\b", Destructive, "xargs deletes its input", Op::Delete),
            rule(r"\b(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-zA-Z]*R", Destructive, "recursive permission or ownership change", Op::Permission),
            rule(r"\b(?:mkfs|shred|dd\s+if=)", Destructive, "low-level disk write", Op::Disk),
            rule_i(r"\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b", Destructive, "destructive SQL", Op::Sql),
            rule_i(r#"\bDELETE\s+FROM\s+\S+\s*(?:;|$|")"#, Destructive, "DELETE without WHERE", Op::Sql),
            rule(
                r#"\beval\s+["']?(?:\$\(|`)|\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba|z|da)?sh\b"#,
                Destructive,
                "runs a command built at runtime",
                Op::Eval,
            ),
            rule(r"\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b", External, "runs downloaded code", Op::DownloadExec),
            rule(&git(r"push\b"), External, "git push changes the remote", Op::GitPush),
            rule(r"\b(?:npm|pnpm|yarn|bun)\s+publish\b", External, "package publish", Op::Publish),
            rule(r"\b(?:cargo|twine|gem|dotnet\s+nuget)\s+(?:publish|upload|push)\b", External, "package publish", Op::Publish),
            rule(r"\bgh\s+pr\s+merge\b", External, "GitHub pull request merge", Op::GithubMerge),
            rule(
                r"\bgh\s+(?:pr\s+(?:create|close|comment|review)|issue\s+(?:create|close|comment)|release\s+create|repo\s+(?:create|delete))\b",
                External,
                "GitHub write operation",
                Op::Github,
            ),
            rule(
                r"\b(?:kubectl\s+(?:apply|delete|scale|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy))\b",
                External,
                "infrastructure change",
                Op::Infra,
            ),
            rule(r"\bdocker\s+push\b", External, "image push", Op::DockerPush),
            rule(
                r"\bdocker\s+(?:(?:system|volume|container|image|network|builder)\s+prune|volume\s+rm)\b|\bdocker(?:\s+|-)compose\b[^\n;&|]*\sdown\b[^\n;&|]*\s(?:-v|--volumes)\b",
                Destructive,
                "docker deletes containers, images or volumes",
                Op::DockerDelete,
            ),
            rule(r"\b(?:vercel|netlify|fly|firebase)\s+deploy\b|\bvercel\s+--prod\b", External, "deploy", Op::Deploy),
            rule(
                r"\bcurl\b[^\n;&|]*?(?:\s-[a-zA-Z]*[dFT]\b|\s--(?:data(?:-[\w]+)?|form(?:-string)?|upload-file|json)\b|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request[= ]\s*(?:POST|PUT|PATCH|DELETE)\b)",
                External,
                "remote write request",
                Op::RemoteWrite,
            ),
            rule(
                r"\bwget\b[^\n;&|]*(?:--post-(?:data|file)|--body-(?:data|file)|--method[= ]\s*(?:POST|PUT|PATCH|DELETE)\b)",
                External,
                "remote write request",
                Op::RemoteWrite,
            ),
            rule(
                r#"(?:>>?|\btee\b(?:\s+-a)?)\s*["']?(?:~|\$HOME|/root|/home/[^/\s]+)/(?:\.ssh/|\.bashrc|\.zshrc|\.profile|\.bash_profile|\.npmrc|\.gitconfig|\.relay/)|(?:>>?|\btee\b(?:\s+-a)?)\s*["']?/etc/"#,
                External,
                "writes a shell, credential or system configuration file",
                Op::ConfigWrite,
            ),
            CommandRule {
                pattern: regex(r"(?:^|[\s;&|(])(?:\./|\S*/)?[\w.-]*(?:deploy|rollout|publish)[\w.-]*\.(?:sh|bash|ps1|py|js|mjs|ts)\b"),
                kind: External,
                reason: "runs a script named like a deployment",
                operation: Op::Deploy,
                accept: Some(deploy_script_accept),
            },
        ]
    })
}

/// Interpreters that run code given on the command line.
const INLINE_INTERPRETERS: [&str; 10] = [
    "python", "python3", "py", "node", "nodejs", "deno", "bun", "ruby", "perl", "php",
];
const INLINE_FLAGS: [&str; 7] = ["-c", "-e", "-p", "--eval", "--print", "-r", "-E"];

fn inline_code_rules() -> &'static [(Regex, ToolEffectKind, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, ToolEffectKind, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (
                regex(r"\b(?:rmtree|rmSync|rmdirSync|unlinkSync|unlink|os\.remove|os\.rmdir|os\.removedirs|fs\.rm|fs\.promises\.rm|rimraf|File\.delete|FileUtils\.rm|Dir\.rmdir|truncate)\b"),
                ToolEffectKind::Destructive,
                "inline code deletes files",
            ),
            (
                regex(r#"\b(?:requests\.(?:post|put|patch|delete)|urlopen|axios\.(?:post|put|patch|delete)|http\.request|https\.request|smtplib|Net::HTTP\.post|curl_exec|socket\.connect)\b|fetch\([^)]*method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)"#),
                ToolEffectKind::External,
                "inline code sends data to a remote host",
            ),
        ]
    })
}

/// Basenames of scripts that are checks.
const CHECK_SCRIPTS: [&str; 7] = ["test", "ci", "check", "verify", "lint", "build", "validate"];

/// Test runners: any invocation is a check.
const TEST_RUNNERS: [&str; 24] = [
    "vitest",
    "jest",
    "mocha",
    "ava",
    "tap",
    "pytest",
    "py.test",
    "tox",
    "nox",
    "rspec",
    "phpunit",
    "ctest",
    "bats",
    "flake8",
    "pylint",
    "mypy",
    "pyright",
    "eslint",
    "stylelint",
    "oxlint",
    "golangci-lint",
    "shellcheck",
    "tsc",
    "ruff",
];

/// Programs whose check is selected by a subcommand.
fn subcommand_checks(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "go" => &["test", "vet", "build"],
        "cargo" => &["test", "check", "build", "clippy", "nextest", "fmt"],
        "dotnet" => &["test", "build"],
        "swift" => &["test", "build"],
        "deno" => &["test", "check", "lint"],
        "bun" => &["test"],
        "biome" => &["check", "lint", "ci"],
        "mvn" | "mvnw" => &["test", "verify", "package", "compile", "check"],
        "gradle" | "gradlew" => &["test", "check", "build", "assemble"],
        "ng" => &["test", "lint", "build", "e2e"],
        "playwright" => &["test"],
        "cypress" => &["run"],
        "make" | "gmake" => &[
            "test", "tests", "check", "lint", "build", "verify", "ci", "all",
        ],
        _ => return None,
    })
}

const PACKAGE_MANAGERS: [&str; 4] = ["npm", "pnpm", "yarn", "bun"];
/// Words in a package script name that mark it as a check; they may be joined by `:`, `-` or `_`.
const CHECK_SCRIPT_WORDS: [&str; 13] = [
    "test",
    "tests",
    "check",
    "lint",
    "typecheck",
    "build",
    "verify",
    "ci",
    "validate",
    "e2e",
    "spec",
    "compile",
    "tsc",
];
/// Words that mark a script as something other than a finished check.
const NON_CHECK_SCRIPT_WORDS: [&str; 9] = [
    "watch", "dev", "start", "serve", "publish", "release", "install", "clean", "fix",
];

/// Wrappers that run the next program unchanged.
const WRAPPERS: [&str; 11] = [
    "env",
    "time",
    "command",
    "nohup",
    "sudo",
    "exec",
    "npx",
    "pnpx",
    "bunx",
    "cross-env",
    "corepack",
];

fn is_assignment(word: &str) -> bool {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    for char in chars {
        if char == '=' {
            return true;
        }
        if !(char.is_ascii_alphanumeric() || char == '_') {
            return false;
        }
    }
    false
}

/// Drops leading environment assignments and wrappers (`env`, `npx`, `pnpm exec`) from a command.
pub fn strip_wrappers(argv: &[String]) -> Vec<String> {
    let mut words: Vec<String> = argv.to_vec();
    let skip_flags = |words: &mut Vec<String>| {
        while words.first().is_some_and(|word| word.starts_with('-')) {
            words.remove(0);
        }
    };
    for _ in 0..6 {
        let Some(first) = words.first().cloned() else {
            break;
        };
        if is_assignment(&first) {
            words.remove(0);
            continue;
        }
        let name = program_name(&first);
        if WRAPPERS.contains(&name.as_str()) {
            words.remove(0);
            skip_flags(&mut words);
            continue;
        }
        let second = words.get(1).map(String::as_str);
        if matches!(name.as_str(), "pnpm" | "yarn" | "bun")
            && matches!(second, Some("exec" | "dlx"))
        {
            words.drain(..2);
            continue;
        }
        if name == "npm" && second == Some("exec") {
            words.drain(..2);
            skip_flags(&mut words);
            continue;
        }
        break;
    }
    words
}

fn is_check_script(script: &str) -> bool {
    let lower = script.to_lowercase();
    let parts: Vec<&str> = lower
        .split([':', '-', '_', '.'])
        .filter(|part| !part.is_empty())
        .collect();
    parts.iter().any(|part| CHECK_SCRIPT_WORDS.contains(part))
        && !parts
            .iter()
            .any(|part| NON_CHECK_SCRIPT_WORDS.contains(part))
}

fn strip_shell_extension(name: &str) -> &str {
    name.strip_suffix(".sh")
        .or_else(|| name.strip_suffix(".bash"))
        .unwrap_or(name)
}

/// Whether one simple command runs a recognized check.
fn is_check_command(argv: &[String]) -> bool {
    let words = strip_wrappers(argv);
    let Some(first) = words.first() else {
        return false;
    };
    let name = program_name(first);
    let args = &words[1..];
    let first_plain = args
        .iter()
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str);
    let has = |flag: &str| args.iter().any(|arg| arg == flag);

    if name == "tsc" {
        return !["--init", "--help", "-h", "--version", "-v"]
            .iter()
            .any(|flag| has(flag));
    }
    if name == "ruff" {
        return first_plain.is_none()
            || first_plain == Some("check")
            || (first_plain == Some("format") && has("--check"));
    }
    if name == "prettier" {
        return ["--check", "-c", "--list-different", "-l"]
            .iter()
            .any(|flag| has(flag));
    }
    if TEST_RUNNERS.contains(&name.as_str()) {
        return true;
    }
    if matches!(name.as_str(), "python" | "python3" | "py")
        && args.first().map(String::as_str) == Some("-m")
    {
        let module = args.get(1).map(String::as_str).unwrap_or("");
        return [
            "pytest", "unittest", "mypy", "ruff", "pyright", "flake8", "tox", "nox",
        ]
        .contains(&module);
    }
    if name == "node" {
        return has("--test");
    }
    if PACKAGE_MANAGERS.contains(&name.as_str()) {
        let mut plain: Vec<&str> = Vec::new();
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();
            if arg == "--" {
                break;
            }
            if arg.starts_with('-') {
                if matches!(
                    arg,
                    "-w" | "-F"
                        | "-C"
                        | "--workspace"
                        | "--filter"
                        | "--prefix"
                        | "--cwd"
                        | "--dir"
                ) {
                    index += 1;
                }
                index += 1;
                continue;
            }
            plain.push(arg);
            index += 1;
        }
        let first = plain.first().copied();
        let second = plain.get(1).copied();
        if matches!(first, Some("test" | "t" | "tst")) {
            return true;
        }
        if matches!(first, Some("run" | "run-script")) {
            return second.is_some_and(is_check_script);
        }
        if name == "bun" && first == Some("test") {
            return true;
        }
        if let Some(first) = first {
            if name != "npm"
                && !["install", "add", "remove", "publish", "exec", "dlx"].contains(&first)
            {
                return is_check_script(first);
            }
        }
        return false;
    }
    if let Some(subcommands) = subcommand_checks(&name) {
        if name == "make" || name == "gmake" {
            let targets: Vec<&String> = args
                .iter()
                .filter(|arg| !arg.starts_with('-') && !arg.contains('='))
                .collect();
            return targets.is_empty()
                || targets
                    .iter()
                    .all(|target| subcommands.contains(&target.as_str()));
        }
        if name == "gradle" || name == "gradlew" {
            return args
                .iter()
                .any(|arg| subcommands.contains(&arg.rsplit(':').next().unwrap_or(arg)));
        }
        return first_plain.is_some_and(|plain| subcommands.contains(&plain));
    }
    if matches!(name.as_str(), "bash" | "sh" | "zsh") {
        let script = args.iter().find(|arg| !arg.starts_with('-'));
        return script.is_some_and(|script| {
            CHECK_SCRIPTS.contains(&strip_shell_extension(&program_name(script)))
        });
    }
    CHECK_SCRIPTS.contains(&strip_shell_extension(&name))
        && (first.ends_with(".sh") || first.ends_with(".bash"))
}

fn trim_trailing_slashes(path: &str) -> &str {
    path.trim_end_matches('/')
}

/// Directory a command runs in after the `cd` commands before it, relative to the workspace, or
/// None when a `cd` leaves the workspace.
fn working_directory(commands: &[ShellCommand], index: usize) -> Option<String> {
    let mut base = String::new();
    for command in &commands[..index] {
        let argv = &command.argv;
        let program = program_name(&argv[0]);
        if (program == "cd" || program == "pushd")
            && argv.get(1).is_some_and(|target| !target.is_empty())
        {
            let target = argv[1].replace('\\', "/");
            if target.starts_with('/') {
                base = trim_trailing_slashes(&target).to_string();
            } else if target == ".." || target.starts_with("../") || target.starts_with('~') {
                return None;
            } else {
                let relative =
                    trim_trailing_slashes(target.strip_prefix("./").unwrap_or(&target)).to_string();
                base = [base.as_str(), relative.as_str()]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("/");
            }
        }
    }
    Some(base)
}

/// Directories a check covers, from `cd`, `--prefix`, `-C`, `--workspace <path>` and `-p <tsconfig>`.
fn check_scope(commands: &[ShellCommand], index: usize) -> Option<Vec<String>> {
    let normalize = |value: &str| -> Option<String> {
        let path = value.replace('\\', "/");
        let path = trim_trailing_slashes(&path);
        if path.is_empty()
            || path == "."
            || path == ".."
            || path.starts_with("../")
            || path.starts_with('~')
        {
            return None;
        }
        let path = path.strip_prefix("./").unwrap_or(path);
        (path.contains('/') || path.starts_with('/')).then(|| path.to_string())
    };
    let without_last_segment = |value: &str| -> String {
        match value.rfind('/') {
            Some(slash) if !value[slash + 1..].contains('/') => value[..slash].to_string(),
            _ => value.to_string(),
        }
    };
    let base = working_directory(commands, index)?;
    let mut scope: Vec<String> = Vec::new();
    if !base.is_empty() {
        scope.push(base.clone());
    }
    let args = &commands[index].argv;
    let join = |normalized: String| {
        if !base.is_empty() && !normalized.starts_with('/') {
            format!("{base}/{normalized}")
        } else {
            normalized
        }
    };
    for position in 0..args.len().saturating_sub(1) {
        let flag = args[position].as_str();
        let value = args[position + 1].as_str();
        if matches!(
            flag,
            "--prefix"
                | "--cwd"
                | "-C"
                | "--dir"
                | "--root"
                | "-w"
                | "--workspace"
                | "-F"
                | "--filter"
                | "--manifest-path"
        ) {
            let path = if flag == "--manifest-path" {
                without_last_segment(value)
            } else {
                value.to_string()
            };
            if let Some(normalized) = normalize(&path) {
                scope.push(join(normalized));
            }
        } else if matches!(flag, "-p" | "--project") && value.contains('/') {
            if let Some(normalized) = normalize(&without_last_segment(value)) {
                scope.push(join(normalized));
            }
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for entry in scope {
        if !unique.contains(&entry) {
            unique.push(entry);
        }
    }
    (!unique.is_empty()).then_some(unique)
}

/// Whether what follows a check replaces its exit code with another command's: a pipe (unless
/// `pipefail` is set), `||`, or a later command. `&&` keeps the failure.
pub fn masks_exit_code(command: &str, check_end: usize) -> bool {
    let rest = &command[check_end.min(command.len())..];
    if rest.contains("||") || rest.contains(';') || rest.contains('\n') {
        return true;
    }
    rest.contains('|') && !starts_with_pattern(r"\bpipefail\b").is_match(command.as_bytes())
}

struct LocatedCheck {
    end: usize,
    index: usize,
    scope: Option<Vec<String>>,
    files: Option<Vec<String>>,
}

/// Options whose value is a configuration, a directory or an output, not a file the check runs on.
const VALUE_OPTIONS: [&str; 19] = [
    "-c",
    "--config",
    "-p",
    "--project",
    "--prefix",
    "--cwd",
    "-C",
    "--dir",
    "--root",
    "--rootDir",
    "-w",
    "--workspace",
    "-F",
    "--filter",
    "--manifest-path",
    "--reporter",
    "-o",
    "--outfile",
    "--output",
];

/// Source and test files a check names, or None when it names none and runs on its whole scope.
fn check_files(argv: &[String]) -> Option<Vec<String>> {
    let code_file = starts_with_pattern(
        r"(?i)\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|cs|php|swift|scala|vue|svelte|dart|exs?)$",
    );
    let words = strip_wrappers(argv);
    let mut files = Vec::new();
    let mut index = 1;
    while index < words.len() {
        let word = words[index].as_str();
        if VALUE_OPTIONS.contains(&word) {
            index += 2;
            continue;
        }
        if !word.starts_with('-') && code_file.is_match(word.as_bytes()) {
            let normalized = word.replace('\\', "/");
            files.push(
                normalized
                    .strip_prefix("./")
                    .unwrap_or(&normalized)
                    .to_string(),
            );
        }
        index += 1;
    }
    (!files.is_empty()).then_some(files)
}

/// The last check in `command`, or None when it runs none. With `verify_commands`, a simple
/// command is a check when the declared words begin it, past wrappers.
fn last_check(command: &str, verify_commands: &[String]) -> Option<LocatedCheck> {
    let commands = parse_shell(command);
    let declared: Vec<Vec<String>> = verify_commands
        .iter()
        .map(|item| {
            strip_wrappers(
                &item
                    .split_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|tokens| !tokens.is_empty())
        .collect();
    let is_check = |argv: &[String]| {
        if declared.is_empty() {
            return is_check_command(argv);
        }
        let words = strip_wrappers(argv);
        declared.iter().any(|tokens| {
            tokens
                .iter()
                .enumerate()
                .all(|(index, token)| words.get(index) == Some(token))
        })
    };
    (0..commands.len())
        .rev()
        .find(|&index| is_check(&commands[index].argv))
        .map(|index| LocatedCheck {
            end: commands[index].end,
            index,
            scope: check_scope(&commands, index),
            files: check_files(&commands[index].argv),
        })
}

/// Inline interpreter code (`python -c`, `node -e`) that needs authorization, if any.
fn inline_code_effect(commands: &[ShellCommand]) -> Option<(ToolEffectKind, &'static str)> {
    for command in commands {
        let words = strip_wrappers(&command.argv);
        if words.is_empty() || !INLINE_INTERPRETERS.contains(&program_name(&words[0]).as_str()) {
            continue;
        }
        for index in 1..words.len().saturating_sub(1) {
            if !INLINE_FLAGS.contains(&words[index].as_str()) {
                continue;
            }
            let code = words[index + 1].as_bytes();
            if let Some((_, kind, reason)) = inline_code_rules()
                .iter()
                .find(|(pattern, _, _)| pattern.is_match(code))
            {
                return Some((*kind, reason));
            }
        }
    }
    None
}

/// An `scp` or `rsync` argument that names another host.
fn is_remote_spec(arg: &str) -> bool {
    if starts_with_pattern(r"^(?:scp|rsync|ssh|sftp)://").is_match(arg.as_bytes()) {
        return true;
    }
    if starts_with_pattern(r"^[A-Za-z]:[\\/]").is_match(arg.as_bytes()) {
        return false;
    }
    starts_with_pattern(r"^(?:[\w.+-]+@)?(?:[\w.-]+|\[[0-9a-fA-F:.]+\]):").is_match(arg.as_bytes())
}

/// `scp` and `rsync` that send files to another host, or `rsync` that deletes at its destination.
fn remote_copy_effect(commands: &[ShellCommand]) -> Option<(ToolEffectKind, String)> {
    for command in commands {
        let words = strip_wrappers(&command.argv);
        let name = words
            .first()
            .map(|word| program_name(word))
            .unwrap_or_default();
        if name != "scp" && name != "rsync" {
            continue;
        }
        let args = &words[1..];
        let deletes = starts_with_pattern(r"^--(?:del|delete(?:-[a-z]+)?|remove-source-files)$");
        if name == "rsync" && args.iter().any(|arg| deletes.is_match(arg.as_bytes())) {
            return Some((
                ToolEffectKind::Destructive,
                "rsync --delete removes files at the destination".to_string(),
            ));
        }
        let destination = args.iter().rfind(|arg| !arg.starts_with('-'));
        if destination.is_some_and(|destination| is_remote_spec(destination)) {
            return Some((
                ToolEffectKind::External,
                format!("{name} sends files to another host"),
            ));
        }
    }
    None
}

/// Programs that move files: `mv`, and `move`/`Move-Item` on Windows.
const MOVE_PROGRAMS: [&str; 4] = ["mv", "move", "move-item", "mi"];

/// `mv` of workspace files to a place outside the workspace, which removes them from the project.
fn move_out_effect(
    commands: &[ShellCommand],
    context: &ClassifyContext,
) -> Option<(ToolEffectKind, &'static str)> {
    let outside = |path: &str| {
        let text = path.replace('\\', "/");
        text == ".." || text.starts_with("../") || !in_workspace(&text, context)
    };
    let windows_flag = |word: &str| {
        word.len() == 2 && word.starts_with('/') && word.as_bytes()[1].is_ascii_alphabetic()
    };
    for command in commands {
        let words = strip_wrappers(&command.argv);
        if words.is_empty()
            || !MOVE_PROGRAMS.contains(&program_name(&words[0]).to_lowercase().as_str())
        {
            continue;
        }
        let paths: Vec<&String> = words[1..]
            .iter()
            .filter(|word| !word.starts_with('-') && !windows_flag(word))
            .collect();
        if paths.len() < 2 || !outside(paths[paths.len() - 1]) {
            continue;
        }
        if paths[..paths.len() - 1]
            .iter()
            .any(|source| !outside(source))
        {
            return Some((
                ToolEffectKind::Destructive,
                "moves workspace files out of the workspace",
            ));
        }
    }
    None
}

/// Every risky operation a command line performs, not only the first one that classifies it.
pub fn risky_operations(command: &str, context: &ClassifyContext) -> Vec<RiskyOperation> {
    let mut operations = BTreeSet::new();
    for rule in command_rules() {
        if rule.matches(command.as_bytes()) {
            operations.insert(rule.operation);
        }
    }
    let commands = parse_shell(command);
    if inline_code_effect(&commands).is_some() {
        operations.insert(RiskyOperation::InlineCode);
    }
    if remote_copy_effect(&commands).is_some() {
        operations.insert(RiskyOperation::RemoteCopy);
    }
    if move_out_effect(&commands, context).is_some() {
        operations.insert(RiskyOperation::MoveOut);
    }
    operations.into_iter().collect()
}

/// Programs that delete the paths they are given.
const DELETE_PROGRAMS: [&str; 9] = [
    "rm",
    "unlink",
    "shred",
    "rmdir",
    "rd",
    "del",
    "erase",
    "remove-item",
    "ri",
];
/// `cmd.exe` deletion programs, whose options are `/s`, `/q`.
const CMD_DELETE_PROGRAMS: [&str; 4] = ["rmdir", "rd", "del", "erase"];

/// The paths the deletion commands of a command line remove, as written. None when a target cannot
/// be named safely (a glob, `~`, `..`, `.`, `/`, a variable or substitution) or the deletion goes
/// through `find` or `xargs`.
pub fn deletion_targets(command: &str) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    for shell_command in parse_shell(command) {
        let words = strip_wrappers(&shell_command.argv);
        let Some(first) = words.first() else { continue };
        let name = program_name(first).to_lowercase();
        if name == "xargs" {
            return None;
        }
        if name == "find"
            && words
                .iter()
                .any(|word| matches!(word.as_str(), "-delete" | "-exec" | "-execdir"))
        {
            return None;
        }
        if !DELETE_PROGRAMS.contains(&name.as_str()) {
            continue;
        }
        for word in &words[1..] {
            let cmd_flag = CMD_DELETE_PROGRAMS.contains(&name.as_str())
                && word.len() == 2
                && word.starts_with('/')
                && word.as_bytes()[1].is_ascii_alphabetic();
            if word.starts_with('-') || cmd_flag {
                continue;
            }
            let mut path = word.replace('\\', "/");
            while let Some(stripped) = path.strip_prefix("./") {
                path = stripped.to_string();
            }
            if path.len() > 1 {
                let trimmed = path.trim_end_matches('/');
                path = if trimmed.is_empty() {
                    "/".to_string()
                } else {
                    trimmed.to_string()
                };
            }
            let parent_reference = path == ".."
                || path.starts_with("../")
                || path.contains("/../")
                || path.ends_with("/..");
            let unsafe_target = path.is_empty()
                || path == "."
                || path == "/"
                || path == "~"
                || path.starts_with("~/")
                || parent_reference
                || path.chars().any(|char| "*?[]{}$`".contains(char));
            if unsafe_target {
                return None;
            }
            targets.push(path);
        }
    }
    (!targets.is_empty()).then_some(targets)
}

/// Options that carry the script of `sed` and `perl`, so the next word is not a file.
const SCRIPT_OPTIONS: [&str; 5] = ["-e", "-E", "-f", "--expression", "--file"];

/// Files named by `sed -i` and `perl -i`: the words that are neither options nor the script.
fn in_place_targets(args: &[String]) -> Vec<String> {
    let mut files = Vec::new();
    let mut script_given = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if SCRIPT_OPTIONS.contains(&arg) {
            script_given = true;
            index += 1;
        } else if arg.starts_with("--expression=") || arg.starts_with("--file=") {
            script_given = true;
        } else if !arg.is_empty() && !arg.starts_with('-') {
            files.push(arg.to_string());
        }
        index += 1;
    }
    if script_given {
        files
    } else {
        files.into_iter().skip(1).collect()
    }
}

/// The subcommand of a `git` command line, past `-C dir` and `-c key=value`.
fn git_subcommand(args: &[String]) -> Option<&str> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == "-C" || args[index] == "-c" {
            index += 2;
        } else if !args[index].starts_with('-') {
            return Some(&args[index]);
        } else {
            index += 1;
        }
    }
    None
}

/// Files a simple command modifies, by program and by output redirection. Some(empty) means it
/// edits files it does not name.
fn command_writes(argv: &[String], outputs: &[String]) -> Option<Vec<String>> {
    let words = strip_wrappers(argv);
    let name = words
        .first()
        .map(|word| program_name(word))
        .unwrap_or_default();
    let args: &[String] = if words.is_empty() { &[] } else { &words[1..] };
    let plain: Vec<String> = args
        .iter()
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .cloned()
        .collect();
    let sed_in_place = |arg: &String| {
        arg == "--in-place"
            || arg.starts_with("--in-place=")
            || starts_with_pattern(r"^-[a-zA-Z]*i").is_match(arg.as_bytes())
    };
    let perl_in_place =
        |arg: &String| starts_with_pattern(r"^-[0-9a-zA-Z]*i").is_match(arg.as_bytes());
    let in_place = (name == "sed" && args.iter().any(sed_in_place))
        || (name == "perl" && args.iter().any(perl_in_place));
    let files: Option<Vec<String>> = if in_place {
        Some(in_place_targets(args))
    } else if name == "tee" || name == "mv" {
        Some(plain.clone())
    } else if name == "cp" || name == "install" {
        Some(plain.last().cloned().into_iter().collect())
    } else if name == "patch"
        || (name == "git"
            && git_subcommand(args) == Some("apply")
            && !args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "--check" | "--stat" | "--numstat" | "--summary"
                )
            }))
    {
        Some(Vec::new())
    } else {
        None
    };
    if files.is_none() && outputs.is_empty() {
        return None;
    }
    let mut written = files.unwrap_or_default();
    written.extend(outputs.iter().cloned());
    Some(written)
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/')
}

/// Whether a path a command writes is in the workspace: not a device, a temporary file or a home file.
fn in_workspace(path: &str, context: &ClassifyContext) -> bool {
    let text = path.replace('\\', "/");
    if text.starts_with("/dev/") || text == "~" || text.starts_with("~/") {
        return false;
    }
    if !is_absolute(&text) {
        return true;
    }
    if let Some(cwd) = &context.cwd {
        if is_within(&text, cwd) {
            return true;
        }
    }
    if is_temporary(&text, context) {
        return false;
    }
    context.cwd.is_none()
}

/// Workspace files the commands of one shell line modify, and the position of the last command that
/// modifies one. A check's own output redirection and a pipe that keeps its output are not changes.
fn shell_writes(
    commands: &[ShellCommand],
    context: &ClassifyContext,
) -> Option<(Vec<String>, usize)> {
    let mut paths = Vec::new();
    let mut last: Option<usize> = None;
    for (index, command) in commands.iter().enumerate() {
        if is_check_command(&command.argv) {
            continue;
        }
        if index > 0
            && commands[index - 1].next == "|"
            && is_check_command(&commands[index - 1].argv)
        {
            continue;
        }
        let Some(written) = command_writes(&command.argv, &command.outputs) else {
            continue;
        };
        let base = working_directory(commands, index);
        let mut kept = Vec::new();
        for path in &written {
            let rooted = is_absolute(&path.replace('\\', "/")) || path.starts_with('~');
            let resolved = match &base {
                Some(base) if !base.is_empty() && !rooted => format!("{base}/{path}"),
                _ => path.clone(),
            };
            if in_workspace(&resolved, context) {
                kept.push(resolved);
            }
        }
        // Named files that are all outside the workspace change nothing it holds.
        if !written.is_empty() && kept.is_empty() {
            continue;
        }
        paths.extend(kept);
        last = Some(index);
    }
    last.map(|last| (paths, last))
}

/// Classify a shell command. With `verify_commands`, only those commands count as verification.
/// A check whose exit code is masked, or that runs in the background, is not verification.
pub fn classify_command(
    command: &str,
    verify_commands: &[String],
    context: &ClassifyContext,
) -> ToolEffect {
    let with = |kind: ToolEffectKind, reason: Option<String>| ToolEffect {
        command: Some(command.to_string()),
        reason,
        ..ToolEffect::new(kind)
    };
    if let Some(rule) = command_rules()
        .iter()
        .find(|rule| rule.matches(command.as_bytes()))
    {
        return with(rule.kind, Some(rule.reason.to_string()));
    }
    let commands = parse_shell(command);
    if let Some((kind, reason)) = inline_code_effect(&commands) {
        return with(kind, Some(reason.to_string()));
    }
    if let Some((kind, reason)) = remote_copy_effect(&commands) {
        return with(kind, Some(reason));
    }
    if let Some((kind, reason)) = move_out_effect(&commands, context) {
        return with(kind, Some(reason.to_string()));
    }
    let writes = shell_writes(&commands, context);
    let check = last_check(command, verify_commands);
    let mut effect = with(ToolEffectKind::Execute, None);
    effect.writes = writes.as_ref().map(|(paths, _)| paths.clone());
    if let Some(check) = check {
        let backgrounded = commands
            .get(check.index)
            .is_some_and(|located| located.next == "&");
        let edited_after = writes.as_ref().is_some_and(|(_, last)| *last > check.index);
        if !backgrounded && !masks_exit_code(command, check.end) && !edited_after {
            effect.kind = ToolEffectKind::Verify;
            effect.scope = check.scope;
            effect.files = check.files;
        }
    }
    effect
}

/// Collapses `.` and `..` and separators without touching the file system.
pub fn normalize_path(path: &str) -> String {
    let text = path.replace('\\', "/");
    let absolute = is_absolute(&text);
    let drive = if text.len() >= 3
        && text.as_bytes()[1] == b':'
        && is_absolute(&text)
        && !text.starts_with('/')
    {
        text[..3].to_string()
    } else if absolute {
        "/".to_string()
    } else {
        String::new()
    };
    let rest = &text[drive.len()..];
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.last().is_some_and(|last| *last != "..") {
                parts.pop();
            } else if !absolute {
                parts.push("..");
            }
        } else {
            parts.push(part);
        }
    }
    format!("{drive}{}", parts.join("/"))
}

/// Files that run code or hold credentials.
fn sensitive_paths() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?:^|/)\.git/(?:hooks/|config$)",
            r"(?:^|/)\.husky/",
            r"(?:^|/)\.relay/(?:settings\.json|mcp\.json|extensions/|agent/)",
            r"(?:^|/)\.ssh/",
            r"(?:^|/)\.(?:bashrc|zshrc|profile|bash_profile|zprofile|npmrc|gitconfig)$",
            r"(?:^|/)\.config/(?:git|fish)/",
        ]
        .iter()
        .map(|pattern| regex(pattern))
        .collect()
    })
}

const TEMP_ROOTS: [&str; 4] = [
    "/tmp/",
    "/var/tmp/",
    "/private/tmp/",
    "/private/var/folders/",
];

/// A path in a form that compares equal for the same file: normalized, and lowercase with a drive letter.
fn comparable_path(path: &str) -> String {
    let text = path.replace('\\', "/");
    let normalized = normalize_path(text.trim_end_matches('/'));
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// Whether the absolute `path` is `root` or inside it.
fn is_within(path: &str, root: &str) -> bool {
    let full = comparable_path(path);
    let base = comparable_path(root);
    full == base || full.starts_with(&format!("{base}/"))
}

/// The absolute `path` relative to `root`, or None when it is not inside `root`.
pub fn relative_to_root(path: &str, root: &str) -> Option<String> {
    let full = comparable_path(path);
    let base = comparable_path(root);
    if full == base {
        return Some(String::new());
    }
    if !full.starts_with(&format!("{base}/")) {
        return None;
    }
    Some(normalize_path(&path.replace('\\', "/"))[base.len() + 1..].to_string())
}

/// Whether the absolute `path` is in a temporary directory.
fn is_temporary(path: &str, context: &ClassifyContext) -> bool {
    let text = normalize_path(&path.replace('\\', "/"));
    TEMP_ROOTS.iter().any(|root| text.starts_with(root))
        || context
            .temp_dir
            .as_ref()
            .is_some_and(|temp| is_within(&text, temp))
}

/// Why writing `path` needs authorization, or None when it is an ordinary workspace file.
pub fn risky_write_path(path: &str, context: &ClassifyContext) -> Option<&'static str> {
    let mut resolved = path.replace('\\', "/");
    if let Some(home) = &context.home {
        if resolved == "~" || resolved.starts_with("~/") {
            resolved = format!(
                "{}{}",
                home.replace('\\', "/").trim_end_matches('/'),
                &resolved[1..]
            );
        }
    }
    let cwd = context
        .cwd
        .as_ref()
        .map(|cwd| cwd.replace('\\', "/").trim_end_matches('/').to_string());
    let full = match &cwd {
        Some(cwd) if !is_absolute(&resolved) => normalize_path(&format!("{cwd}/{resolved}")),
        _ => normalize_path(&resolved),
    };
    if sensitive_paths()
        .iter()
        .any(|pattern| pattern.is_match(full.as_bytes()))
    {
        return Some("writes a file that runs code or holds credentials");
    }
    if let Some(cwd) = &cwd {
        if is_absolute(&full) && !is_within(&full, cwd) && !is_temporary(&full, context) {
            return Some("writes outside the workspace");
        }
    }
    None
}

const READ_TOOLS: [&str; 9] = [
    "read", "grep", "find", "ls", "glob", "search", "list", "cat", "view",
];
const WRITE_TOOLS: [&str; 7] = [
    "write",
    "edit",
    "multiedit",
    "multi_edit",
    "apply_patch",
    "patch",
    "notebook_edit",
];
const SHELL_TOOLS: [&str; 8] = [
    "bash",
    "shell",
    "sh",
    "powershell",
    "pwsh",
    "exec",
    "terminal",
    "run",
];

/// Default classification by tool name and arguments. Unknown tools are `Execute`.
pub fn classify_tool_call(
    tool_call: &ToolCall,
    verify_commands: &[String],
    context: &ClassifyContext,
) -> ToolEffect {
    let name = tool_call.name.to_lowercase();
    let paths: Vec<String> = tool_call
        .string_arg(&["path", "file_path", "filePath", "file", "notebook_path"])
        .map(|path| vec![path.to_string()])
        .unwrap_or_default();
    if SHELL_TOOLS.contains(&name.as_str()) {
        let command = tool_call
            .string_arg(&["command", "cmd", "script"])
            .unwrap_or("");
        return ToolEffect {
            paths,
            ..classify_command(command, verify_commands, context)
        };
    }
    if WRITE_TOOLS.contains(&name.as_str()) {
        if let Some(reason) = paths
            .iter()
            .find_map(|path| risky_write_path(path, context))
        {
            return ToolEffect {
                paths,
                reason: Some(reason.to_string()),
                ..ToolEffect::new(ToolEffectKind::External)
            };
        }
        return ToolEffect {
            paths,
            ..ToolEffect::new(ToolEffectKind::Write)
        };
    }
    if READ_TOOLS.contains(&name.as_str()) {
        return ToolEffect {
            paths,
            ..ToolEffect::new(ToolEffectKind::Read)
        };
    }
    ToolEffect {
        paths,
        ..ToolEffect::new(ToolEffectKind::Execute)
    }
}

/// Whether an effect changes state.
pub fn is_mutation(kind: ToolEffectKind) -> bool {
    matches!(
        kind,
        ToolEffectKind::Write | ToolEffectKind::Destructive | ToolEffectKind::External
    )
}

/// Whether an effect needs explicit authorization before it runs.
pub fn requires_authorization(kind: ToolEffectKind) -> bool {
    matches!(kind, ToolEffectKind::Destructive | ToolEffectKind::External)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(command: &str) -> ToolEffectKind {
        classify_command(command, &[], &ClassifyContext::default()).kind
    }

    #[test]
    fn classifies_risky_commands_and_checks() {
        assert_eq!(
            kind("git push --force origin main"),
            ToolEffectKind::Destructive
        );
        assert_eq!(kind("git push origin main"), ToolEffectKind::External);
        assert_eq!(kind("git rebase --continue"), ToolEffectKind::Execute);
        assert_eq!(
            kind("git restore --staged src/a.ts"),
            ToolEffectKind::Execute
        );
        assert_eq!(kind("git restore src/a.ts"), ToolEffectKind::Destructive);
        assert_eq!(kind("./deploy.sh --dry-run"), ToolEffectKind::Execute);
        assert_eq!(kind("npm test"), ToolEffectKind::Verify);
        assert_eq!(kind("npm test | tail -5"), ToolEffectKind::Execute);
        assert_eq!(kind("npm test &"), ToolEffectKind::Execute);
    }

    #[test]
    fn lists_every_operation_and_deletion_target() {
        let operations = risky_operations(
            "git push && git reset --hard HEAD~5",
            &ClassifyContext::default(),
        );
        assert_eq!(
            operations,
            [RiskyOperation::GitPush, RiskyOperation::GitReset]
        );
        assert_eq!(
            deletion_targets("rm -rf ./dist/ build"),
            Some(vec!["dist".to_string(), "build".to_string()])
        );
        assert_eq!(deletion_targets("rm -rf dist ~"), None);
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize_path("./a/../b/c"), "b/c");
        assert_eq!(normalize_path("C:\\work\\repo\\..\\x"), "C:/work/x");
        assert_eq!(
            relative_to_root("C:/Work/Repo/src/a.ts", "c:\\work\\repo"),
            Some("src/a.ts".to_string())
        );
    }
}
