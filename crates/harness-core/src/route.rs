//! Deterministic routing of a request to the agents of a catalog: a port of general-agents'
//! `scripts/route.py`, so the orchestrator can route without Python. `tests/route.rs` compares
//! every result with the Python script on the orchestrator's own routing cases.
//!
//! Strength is the term overlap between the request and each agent's name (weight 3) and
//! description (weight 1), IDF-weighted; it decides whether a specialist exists. The score, which
//! orders candidates, is the strength times the square of the IDF-weighted share of the request's
//! terms the agent covers. Negative clauses of a description ("Do not use for React") carry no
//! weight, and a request term found only there raises an exclusion alert. Portuguese request words
//! map to the catalog's English terms through the catalog's alias table.
//!
//! The port keeps Python's semantics where they decide a result: NFKD with combining marks
//! removed, Unicode `\s`, insertion-ordered term maps, phrase aliases applied longest first in file
//! order, and `round(x, 2)`.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::UnicodeNormalization;

/// Strength a candidate needs to be listed.
pub const MIN_SCORE: f64 = 3.0;
/// Strength the best candidate needs for a clear specialist.
pub const STRONG_SCORE: f64 = 6.0;

const STOP_RAW: &str = "
a o as os um uma uns umas de da do das dos em no na nos nas por para pra com sem sobre entre
e ou que qual quais quando como onde porque por que se sua seu suas seus meu minha meus minhas
este esta isto esse essa isso aquele aquela ao aos à às é ser são foi está estão tem ter há
mais menos muito pouco já não sim também só ainda até cada todo toda todos todas outro outra
use usar uso usa faz fazer quero preciso ajuda ajude me eu nós você vocês ele ela eles elas
expert especialista agent agents base baseada baseado livro livros fonte fontes pdf págs pags
the of and or to in for on with is are be what how why when which this that from by an it as
ex exemplo exemplos gatilho gatilhos sigla edição ed cita página paginas marca datado
código codigo revise revisar revisa revisão explica explicar
do does not our your my we you i can should would could will using used uses
specialist specialists book books source sources trigger triggers example examples eg based grounded
page pages cites cite cited covers cover covered also any each such these those their its into than then
about between over under per via
";

/// Spelling variants, in the script's order. Keys with punctuation are replaced before tokenizing.
const ALIASES: &[(&str, &str)] = &[
    ("c#", "csharp"),
    ("k8s", "kubernetes"),
    ("js", "javascript"),
    ("py", "python"),
    ("pg", "postgresql"),
    ("postgres", "postgresql"),
    ("ts", "typescript"),
    ("golang", "go"),
    ("nodejs", "node"),
    ("node.js", "node"),
    ("next.js", "nextjs"),
    ("vue.js", "vue"),
    ("tf.js", "tensorflow"),
    ("tfjs", "tensorflow"),
    ("llms", "llm"),
];

static NEG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(do(es)? not (cover|use|replace|give|treat|handle|provide|include|support|apply|know|test|",
        r"substitute)|not (covered|a substitute|a manual|a technical)|no coverage|out of scope|outside |",
        r"belongs? to|(is|are) routed|routes? [^.;]*? to |other (agents|specialists|experts)|",
        r"redirects?\b|exist only in|those topics are declared|everything else)"
    ))
    .expect("negative clause pattern")
});

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d+(?:\.\d+)*|[a-z0-9][a-z0-9+]*").expect("token pattern"));

static STOP: LazyLock<HashSet<String>> =
    LazyLock::new(|| STOP_RAW.split_whitespace().map(norm).collect());

/// Python's `str.isspace`, which `\s` follows: Unicode white space plus the separators U+001C-U+001F.
fn py_isspace(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python's `str.strip()`.
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(py_isspace)
}

/// Python 3.12+ `sum()` of floats: Neumaier's compensated summation, as CPython does it.
fn py_fsum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for value in values {
        let total = sum + value;
        if sum.abs() >= value.abs() {
            compensation += (sum - total) + value;
        } else {
            compensation += (value - total) + sum;
        }
        sum = total;
    }
    if compensation != 0.0 && compensation.is_finite() {
        sum += compensation;
    }
    sum
}

/// Python's `str.isalnum`, for the alias keys this module holds (ASCII).
fn is_ascii_alnum(text: &str) -> bool {
    text.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Lower case, punctuated aliases spelled out, then NFKD without combining marks.
pub fn norm(text: &str) -> String {
    let mut lowered = text.to_lowercase();
    let mut punctuated: Vec<&(&str, &str)> = ALIASES
        .iter()
        .filter(|(key, _)| !is_ascii_alnum(key))
        .collect();
    // Python's sort is stable: equal lengths keep the table's order.
    punctuated.sort_by_key(|entry| Reverse(entry.0.chars().count()));
    for (key, value) in punctuated {
        lowered = lowered.replace(key, &format!(" {value} "));
    }
    lowered
        .nfkd()
        .filter(|c| canonical_combining_class(*c) == 0)
        .collect()
}

fn alias(term: &str) -> &str {
    ALIASES
        .iter()
        .find(|(key, _)| *key == term)
        .map_or(term, |(_, value)| value)
}

fn is_az09(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// `re.sub(r"(?<![a-z0-9])" + re.escape(key) + r"(?![a-z0-9])", replacement, text)`.
fn replace_bounded(text: &str, key: &str, replacement: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let before_ok = text[..index]
            .chars()
            .next_back()
            .is_none_or(|c| !is_az09(c));
        if before_ok && rest.starts_with(key) {
            let after = index + key.len();
            if text[after..].chars().next().is_none_or(|c| !is_az09(c)) {
                out.push_str(replacement);
                index = after;
                continue;
            }
        }
        let c = rest.chars().next().expect("char at a boundary");
        out.push(c);
        index += c.len_utf8();
    }
    out
}

/// The catalog's Portuguese to English alias table.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    words: HashMap<String, Vec<String>>,
    /// Normalized phrase and its replacement, longest first, file order among equal lengths.
    phrases: Vec<(String, String)>,
}

impl Vocabulary {
    /// `words` and `phrases` as they appear in `vocab_pt.json`, in file order.
    pub fn new(words: &[(String, String)], phrases: &[(String, String)]) -> Self {
        let mut phrases: Vec<(String, String)> = phrases
            .iter()
            .map(|(key, value)| (norm(key), value.clone()))
            .collect();
        phrases.sort_by_key(|entry| Reverse(entry.0.chars().count()));
        Vocabulary {
            words: words
                .iter()
                .map(|(key, value)| {
                    (
                        norm(key),
                        value.split_whitespace().map(str::to_string).collect(),
                    )
                })
                .collect(),
            phrases,
        }
    }
}

/// Terms of a text. `vocabulary` (requests only) maps Portuguese words and phrases to English.
fn tokens(text: &str, vocabulary: Option<&Vocabulary>) -> Vec<String> {
    let mut normalized = norm(text);
    if let Some(vocabulary) = vocabulary {
        for (key, value) in &vocabulary.phrases {
            normalized = replace_bounded(&normalized, key, &format!(" {value} "));
        }
    }
    let mut out = Vec::new();
    for found in TOKEN.find_iter(&normalized) {
        let term = found.as_str();
        // The first alternative of the pattern matched: the term starts with a digit.
        if !term.starts_with(|c: char| c.is_ascii_lowercase()) {
            // A version "2.7.18" becomes "2", "2.7" and "2.7.18": "Spring Boot 3" matches "3.2.x".
            let parts: Vec<&str> = term.split('.').collect();
            for end in 1..=parts.len() {
                out.push(parts[..end].join("."));
            }
            continue;
        }
        let mapped: Vec<String> = match vocabulary.and_then(|vocabulary| vocabulary.words.get(term))
        {
            Some(words) => words.clone(),
            None => vec![term.to_string()],
        };
        for word in mapped {
            let word = alias(&word).to_string();
            if !STOP.contains(&word) && (word.chars().count() > 1 || word == "r") {
                out.push(word);
            }
        }
    }
    out
}

/// A description split into its positive text and its negative clauses.
fn split_text(description: &str) -> (String, String) {
    let chars: Vec<(usize, char)> = description.char_indices().collect();
    let mut clauses = Vec::new();
    let mut start = 0;
    let mut position = 0;
    while position < chars.len() {
        let (offset, c) = chars[position];
        if !py_isspace(c) {
            position += 1;
            continue;
        }
        let mut end = position;
        while end < chars.len() && py_isspace(chars[end].1) {
            end += 1;
        }
        let after_period = position > 0 && matches!(chars[position - 1].1, '.' | ';');
        let mut matched_end = after_period.then_some(end);
        if matched_end.is_none() && end < chars.len() && chars[end].1 == '-' {
            let mut dash_end = end + 1;
            while dash_end < chars.len() && py_isspace(chars[dash_end].1) {
                dash_end += 1;
            }
            if dash_end > end + 1
                && dash_end < chars.len()
                && chars[dash_end].1.is_ascii_uppercase()
            {
                matched_end = Some(dash_end);
            }
        }
        match matched_end {
            Some(stop) => {
                clauses.push(&description[start..offset]);
                start = chars
                    .get(stop)
                    .map_or(description.len(), |(offset, _)| *offset);
                position = stop;
            }
            None => position += 1,
        }
    }
    clauses.push(&description[start..]);
    let mut positive = Vec::new();
    let mut negative = Vec::new();
    for clause in clauses {
        if NEG.is_match(&norm(clause)) {
            negative.push(clause);
        } else {
            positive.push(clause);
        }
    }
    (positive.join(" "), negative.join(" "))
}

/// An agent of the catalog, as routing reads it.
#[derive(Debug, Clone)]
pub struct RouteAgent {
    pub name: String,
    pub description: String,
    pub domain: String,
}

/// Terms and weights of one agent, in insertion order.
#[derive(Debug, Default)]
struct Document {
    terms: Vec<(String, f64)>,
    index: HashMap<String, usize>,
}

impl Document {
    fn set(&mut self, term: String, weight: f64) {
        match self.index.get(&term) {
            Some(&position) => self.terms[position].1 = weight,
            None => {
                self.index.insert(term.clone(), self.terms.len());
                self.terms.push((term, weight));
            }
        }
    }

    fn get(&self, term: &str) -> Option<f64> {
        self.index.get(term).map(|&position| self.terms[position].1)
    }

    fn contains(&self, term: &str) -> bool {
        self.index.contains_key(term)
    }
}

/// The document term matching a request term: itself, its plural or singular, or a close prefix.
fn match_term<'a>(term: &'a str, document: &'a Document) -> Option<&'a str> {
    if document.contains(term) {
        return Some(term);
    }
    let length = term.chars().count();
    let numeric = term.chars().next().is_some_and(char::is_numeric);
    if length >= 4 && !numeric {
        for suffix in ["s", "es"] {
            let plural = format!("{term}{suffix}");
            if let Some((found, _)) = document.terms.iter().find(|(t, _)| *t == plural) {
                return Some(found);
            }
            if let Some(singular) = term.strip_suffix(suffix) {
                if let Some((found, _)) = document.terms.iter().find(|(t, _)| t == singular) {
                    return Some(found);
                }
            }
        }
    }
    if length >= 5 && !numeric {
        // Prefix only for close variations ("postgres" and "postgresql"), never "java" and "javascript".
        for (candidate, _) in &document.terms {
            let (short, long) = if candidate.chars().count() < length {
                (candidate.as_str(), term)
            } else {
                (term, candidate.as_str())
            };
            let (short_length, long_length) = (short.chars().count(), long.chars().count());
            if short_length >= 5 && long.starts_with(short) && long_length - short_length <= 4 {
                return Some(candidate);
            }
        }
    }
    None
}

/// Python's `round(value, 2)`: the exact binary value rounded to two decimals.
fn round2(value: f64) -> f64 {
    format!("{value:.2}").parse().expect("formatted float")
}

/// One ranked agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// Position of the agent in the catalog.
    pub agent: usize,
    pub score: f64,
    pub strength: f64,
    /// Request terms the agent matched, and its name when the request names it.
    pub terms: Vec<String>,
    /// Request terms found only in the agent's negative clauses.
    pub exclusion_alert: Vec<String>,
}

/// A catalog prepared for routing.
pub struct Router {
    agents: Vec<RouteAgent>,
    documents: Vec<Document>,
    negatives: Vec<HashSet<String>>,
    idf: HashMap<String, f64>,
    vocabulary: Vocabulary,
}

impl Router {
    pub fn new(agents: Vec<RouteAgent>, vocabulary: Vocabulary) -> Self {
        let mut documents = Vec::with_capacity(agents.len());
        let mut negatives = Vec::with_capacity(agents.len());
        for agent in &agents {
            let (positive, negative) = split_text(&agent.description);
            let mut document = Document::default();
            for term in tokens(&positive, None) {
                document.set(term, 1.0);
            }
            for term in tokens(&agent.name.replace('-', " "), None) {
                document.set(term, 3.0);
            }
            negatives.push(
                tokens(&negative, None)
                    .into_iter()
                    .filter(|term| !document.contains(term))
                    .collect(),
            );
            documents.push(document);
        }
        let count = documents.len() as f64;
        let mut frequency: HashMap<String, usize> = HashMap::new();
        for document in &documents {
            for (term, _) in &document.terms {
                *frequency.entry(term.clone()).or_default() += 1;
            }
        }
        let idf = frequency
            .into_iter()
            .map(|(term, documents)| (term, (1.0 + count / documents as f64).ln()))
            .collect();
        Router {
            agents,
            documents,
            negatives,
            idf,
            vocabulary,
        }
    }

    /// Every agent with a positive strength, best first; `domain` keeps agents whose domain starts with it.
    pub fn rank(&self, query: &str, domain: Option<&str>) -> Vec<Candidate> {
        let mut terms: Vec<String> = Vec::new();
        for term in tokens(query, Some(&self.vocabulary)) {
            if !terms.contains(&term) {
                terms.push(term);
            }
        }
        let normalized = norm(query);
        let unseen = (1.0 + self.documents.len() as f64).ln();
        let term_idf: Vec<f64> = terms
            .iter()
            .map(|term| self.idf.get(term).copied().unwrap_or(unseen))
            .collect();
        let total = py_fsum(term_idf.iter().copied());
        let mut ranked = Vec::new();
        for (position, agent) in self.agents.iter().enumerate() {
            if domain.is_some_and(|domain| !agent.domain.starts_with(domain)) {
                continue;
            }
            let document = &self.documents[position];
            let mut score = 0.0;
            let mut hits: Vec<String> = Vec::new();
            for term in &terms {
                if let Some(found) = match_term(term, document) {
                    score += document.get(found).unwrap_or(0.0)
                        * self.idf.get(found).copied().unwrap_or(0.5);
                    hits.push(term.clone());
                }
            }
            if normalized.contains(&agent.name) {
                score += 20.0;
                hits.push(agent.name.clone());
            }
            let exclusion_alert: Vec<String> = terms
                .iter()
                .filter(|term| self.negatives[position].contains(*term))
                .cloned()
                .collect();
            if score > 0.0 {
                let coverage = if total != 0.0 {
                    let covered = py_fsum(hits.iter().filter_map(|hit| {
                        terms
                            .iter()
                            .position(|term| term == hit)
                            .map(|index| term_idf[index])
                    }));
                    covered / total
                } else {
                    1.0
                };
                ranked.push(Candidate {
                    agent: position,
                    score: round2(score * (coverage * coverage)),
                    strength: round2(score),
                    terms: hits,
                    exclusion_alert,
                });
            }
        }
        ranked.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(b.strength.total_cmp(&a.strength))
                .then_with(|| self.agents[a.agent].name.cmp(&self.agents[b.agent].name))
        });
        ranked
    }

    /// The candidates `route.py --json` lists: strength at least [`MIN_SCORE`], at most `top`, and
    /// whether the best one is a clear specialist.
    pub fn route(&self, query: &str, top: usize, domain: Option<&str>) -> (bool, Vec<Candidate>) {
        let candidates: Vec<Candidate> = self
            .rank(py_strip(query), domain)
            .into_iter()
            .filter(|candidate| candidate.strength >= MIN_SCORE)
            .take(top.max(1))
            .collect();
        let clear = candidates
            .first()
            .is_some_and(|best| best.strength >= STRONG_SCORE);
        (clear, candidates)
    }

    pub fn agents(&self) -> &[RouteAgent] {
        &self.agents
    }
}
