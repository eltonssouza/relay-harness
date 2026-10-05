---
name: test-evidence
description: Decide whether a test result is evidence. Use when writing a regression test, claiming a fix, verifying a flaky or timing-dependent fix, or proving a test guards a guarantee with a mutation.
---

# Test evidence

A green run shows that the tests that ran passed. It does not show that they can fail, that they ran at all, or that a nondeterministic fix worked. This skill covers the four places where pi work most often confuses the two. Run test commands as AGENTS.md says (specific files with the vitest CLI or `node --test`, never the full vitest suite).

## 1. A red observation for every regression test

A regression test counts only after it has been seen failing for the right reason, before the fix:

- It **ran**: collected, not skipped, not filtered away by a `-t` pattern that matched nothing. Check the summary line for the test count.
- It failed **for the stated reason**: the assertion names the missing behavior. A `TypeError`, a missing import, or a missing fixture means the test is broken, not red.
- The **exit code** was non-zero.

Run the new test against the unfixed source first. If the fix is already written, revert it locally, observe the failure, and restore it.

## 2. The four ways the loop is faked

| Fake | Sign | Why it proves nothing |
|---|---|---|
| Test written after the code | Green on its first run | Never seen failing |
| Assertion that cannot fail | `toBeTruthy()` on an object, `toBeDefined()` on a return value | Pins nothing |
| Red for the wrong reason | First failure was an import or type error | Only the wiring was missing |
| Suite filtered down | `-t "new case"` kept for later runs | Other cases stopped running; a regression lands green |

Before claiming "tests pass", rerun the whole file without a name filter.

## 3. Flaky and timing-dependent fixes

One green run is the most likely outcome of *not* having fixed a flake. If it failed with probability `p` before the fix, `N` green runs happen anyway with probability `(1 - p)^N`. For about 95% confidence, `N ≈ 3 / p`:

| Failure rate before the fix | Runs needed |
|---|---|
| 1 in 2 | 6 |
| 1 in 3 | 9 |
| 1 in 6 | 18 |
| 1 in 10 | 30 |

- Measure `p` first from runs before the fix. Without it, a run count proves nothing: three greens against a 1-in-6 flake is a coin flip (`(5/6)^3 ≈ 0.58`).
- Report the arithmetic: `18/18 green; rate before fix 2/12 ≈ 1/6, so 18 runs ≈ 95%`.
- The formula assumes independent runs. Machine load comes in episodes: list the run results in order, space runs out, and record what else was running. If failures cluster, say the result is bounded by that.
- Check the failure signature before naming a culprit. All timeouts with no assertion failures, moving between files, is load contention, not a flaky test. Do not run two heavy suites at once; they starve each other and the timeouts read as regressions.
- When `N` is impractical (a 1-in-50 flake needs about 150 runs), verify by mechanism (the causal chain plus a mutation that brings the failure back) or report the fix as "unverified by repetition".

## 4. Mutation check for a guarantee

To show a test guards a guarantee: change the source so the guarantee is false, watch the named test fail, revert, and watch it pass.

- The mutated source must still pass `npm run check`. A mutation that breaks compilation or an import kills tests by erroring, indiscriminately; record it as invalid and redo it as a behavior change.
- A mutation no test kills is a survivor. Report it; do not drop it.
- Report a table: mutation, tests that failed, survivors.
