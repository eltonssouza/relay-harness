# Thresholds, and the difference between scanned and clean

Load this when setting or applying the gate's numbers.

## The numbers this gate blocks on

They live here, in one place, so they cannot be satisfied in one file and
ignored in another:

| Check | Threshold | Not negotiable because |
|---|---|---|
| Dependency CVEs | **Zero Critical with a fix available** | A fix exists; not applying it is a choice, and it needs an owner's name, not a sprint |
| High CVEs | Documented and risk-accepted by a named owner, with a date | "We know about it" is not acceptance |
| Secrets scan | **Zero findings** | A committed secret is compromised from the moment it is committed, not from when it is used |
| SBOM | Generated for the artifact that ships | An SBOM of a different build answers a different question |
| Provenance and signature | Recorded for the artifact that ships | Verifiable, or it is a claim |

A Critical with **no** fix available is not a pass - it is an accepted risk
with a compensating control and a date to look again.

## Scanned is not clean

Four ways a green scan means nothing, all of them common:

1. **Scanned the wrong thing.** The lockfile, not the image; the image, not the
   running container's added layers. Name what was scanned in the report.
2. **Scanned with stale data.** A vulnerability database from last month
   cannot know about last week. Record the database date next to the result.
3. **Scanned with the finding suppressed.** An ignore file that nobody has read
   since it was created. Every suppression needs a reason and a date, and an
   expired suppression is a finding.
4. **Scanned a build that is not the one shipping.** Build once, scan that, ship
   that. Anything else scans a sibling.

## Transitive is where the risk actually lives

Direct dependencies get chosen and reviewed. Transitive ones arrive. The
questions worth asking of the tree, not just the manifest:

- Which packages execute code at install time?
- Which are unmaintained - last release measured in years, single maintainer?
- Which arrived recently without a direct dependency changing?
- Which have a name one character from a popular package?

## The report that is worth reading

Not "the scan passed". Five things:

- The exact command and its **real exit code**.
- What was scanned - artifact, digest, lockfile - and when.
- The vulnerability database version.
- Findings by severity, with each Critical either fixed or accepted by name.
- Every active suppression, with its reason and its expiry.

A report missing the exit code is a claim. A report missing the suppressions is
a claim that has been edited.
