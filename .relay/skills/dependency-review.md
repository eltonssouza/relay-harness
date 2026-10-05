---
name: dependency-review
description: Review a dependency or lockfile change, or audit the dependency tree. Use before adding, updating, or removing an npm dependency, when package-lock.json changes, or when reporting audit results.
---

# Dependency review

AGENTS.md sets the install rules (exact pins, `--ignore-scripts`, the install-lock allowlist, the lockfile guard). This skill covers what those rules do not: what to ask of the resolved tree, and what an audit report must contain to count as evidence.

## Ask of the tree, not the manifest

Direct dependencies are chosen and reviewed; transitive ones arrive. For every lockfile diff, answer these for each new or changed package:

1. **Does it run code at install time?** Look for `preinstall`, `install`, `postinstall`, or `prepare` scripts:
   ```bash
   npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"
   ```
   Any new one needs review and an explicit allowlist entry in `scripts/generate-coding-agent-install-lock.mjs`; never add one silently.
2. **Is it maintained?** `npm view <pkg> time.modified maintainers`. Last release measured in years, or a single maintainer, is a risk to state.
3. **Did it arrive without a direct dependency changing?** A new transitive package in a diff whose `package.json` files did not change needs an explanation.
4. **Is its name one character from a popular package?** Compare it with the package you meant to install.

## Audit thresholds

| Check | Threshold |
|---|---|
| Critical advisory with a fix available | Zero. Not applying an available fix is a decision that needs a named owner. |
| Critical with no fix | Accepted risk with a compensating control and a date to recheck; not a pass. |
| High advisory | Accepted by a named owner, with a date. "We know about it" is not acceptance. |
| Committed secret | Zero. A committed secret is compromised at commit time; only rotation fixes it, not deleting it from history. |

## Scanned is not clean

A green audit means nothing when:

1. **The wrong thing was scanned.** The lockfile is not the published tarball. Name what was scanned.
2. **The advisory data was stale.** Record when the audit ran.
3. **A finding was suppressed.** Every suppression needs a reason and an expiry; an expired suppression is a finding.
4. **A sibling build was scanned.** Audit the tree that will ship.

## The report

Not "audit passed". Report:

- the exact command (for example `npm audit --omit=dev`) and its **real exit code**
- what was scanned (lockfile at which commit) and when
- findings by severity, each Critical fixed or accepted by name
- every active suppression with its reason and expiry
- the answers to the four tree questions for each new or changed package

A report missing the exit code is a claim.
