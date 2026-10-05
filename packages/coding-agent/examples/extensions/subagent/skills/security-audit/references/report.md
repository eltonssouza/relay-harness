# Report deliverables

Load this at step 5, once every finding has passed the evidence rules.

## Deliverable 2 — PDF report

Visually clean, written in `REPORT_LANGUAGE`, saved to `REPORT_PATH`:

- **a) Cover**: title "Security Audit Report — \<project name\>" (translated), date, audited scope, commit SHA, `DEPTH`, and a methodology note explaining how each category was mapped onto the detected stack and which tools were run (with versions).
- **b) Executive summary**: finding counts by severity, a donut chart by severity and a bar chart by category. Palette: critical `#B91C1C`, high `#EA580C`, medium `#D97706`, low `#2563EB`, informational `#6B7280`, strength `#059669`.
- **c) Attack surface**: the Phase 0.5 inventory as a table, with trust boundaries and assets.
- **d) Strengths** (what is protected, with evidence) and **weaknesses** (the central risks, stated as themes rather than a list of lines).
- **e) Detailed findings table**, grouped by category: Severity | File:line | CWE | Description, with a colored severity chip.
- **f) Coverage**: the entry-point ledger with verdicts, and the per-category covered/partial/gap table.
- **g) Prioritized recommendations**: P1, P2, P3…, each naming the finding ids it resolves, a rough effort estimate, and which recommendations remove a whole class (a safe query builder, a tenant-scoped repository, a central authorization middleware) rather than one call site.
- **h) Needs manual verification** appendix.
- **i) "GITHUB ISSUES" section, at the very end**: for every actionable finding, the complete Markdown text of an issue, ready to copy and paste, inside a delimited block (`--- ISSUE n ---` … `--- END ISSUE n ---`). Each issue contains:
  - Title in the form `[Security] <short description of the flaw>`
  - Suggested labels: `security` + severity
  - Problem description and why it is exploitable
  - Evidence: file:line with the code snippet (secrets redacted)
  - Impact
  - Suggested fix
  - Acceptance criteria as a verifiable checklist, including the negative test that must exist and fail before the fix

Before publishing the issues, check that none of them reveals an unfixed Critical in a public repository. If the repository is public, mark Critical and High issues for a private security advisory instead of a public issue.

## Deliverable 3 — Machine-readable findings

Write `docs/security-audit/findings.json` next to the PDF: an array of `{id, fingerprint, category, cwe, owasp, severity, exploitability, impact, confidence, file, lines, title, description, sourceToSink, precondition, recommendation, negativeTest, status}`. `fingerprint` is a stable hash of category, file, and the normalized snippet, so a later audit can tell new, fixed, and persisting findings apart. Also write `docs/security-audit/coverage.json` with the entry-point ledger and the per-category verdicts.

## PDF generation — technical rules

- Install nothing globally. Use an isolated environment (a Python venv with `reportlab` + `matplotlib`, or the local stack's equivalent; a headless browser, `wkhtmltopdf` or `pandoc` doing HTML→PDF is equally fine).
- Leave the generator script in `docs/security-audit/` so the report can be regenerated. It must read `findings.json` and `coverage.json` instead of hardcoding the content.
- Verify the PDF you generated: page count, charts rendered, tables legible, no text overflowing a cell or running off the page. Rasterize the pages and look at them if you can. Fix visual defects before delivering.
- A4 pages, ~2cm margins, header and footer with the report name and page number.
- If PDF generation is impossible in this environment, deliver the full report as Markdown, say plainly why, and leave the generator script ready to run.
