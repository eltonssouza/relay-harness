# Keeping a suite worth running

Load this once the suite has more than a handful of tests.

## The four properties worth trading between

Every test has these, and improving one usually costs another. Name which you
are choosing.

| Property | What it means | What it costs to maximise |
|---|---|---|
| **Protection against regressions** | It fails when the behaviour breaks. | More surface per test - which lowers the next one. |
| **Resistance to refactoring** | It does not fail when only the structure changes. | Testing further from the implementation, so failures localise worse. |
| **Fast feedback** | It runs in the time you are willing to wait. | Fewer integration and e2e tests, so less realism. |
| **Maintainability** | A reader can tell what broke and why. | Setup that is explicit rather than shared, so more duplication. |

A test that is weak on all four is not a test to fix, it is a test to delete -
it costs time and protects nothing.

## The smells, and what each one actually costs

| Smell | Tell | Cost |
|---|---|---|
| **Erratic** | Passes and fails without a code change. | The whole suite stops being believed after two of these. |
| **Slow** | Nobody runs it locally. | Feedback moves to CI, so defects are found later and cost more. |
| **Obscure** | Failure message does not say what broke. | Every failure becomes an investigation. |
| **Fragile** | Fails on every refactor. | Refactoring stops happening. That is the expensive one. |
| **Mystery guest** | Depends on data it did not create. | Passes alone, fails in a different order. |
| **Assertion roulette** | Many assertions, no messages. | You learn one failure per run instead of all of them. |

## The rule about flakes

A flaky test is broken. Not noisy - broken. The two honest responses are to fix
the cause or to delete the test. Retrying it until it passes converts a real
signal into a slower green build, and it teaches everyone that red does not
mean anything.

When the cause is not obvious, quarantine it explicitly: move it out of the
blocking suite, record why and when, and give it an owner. Quarantine is a
decision with a name attached; a retry flag is the same decision hidden.

## Selectors and the e2e layer

E2E tests fail for the most reasons and give the least localised information,
so keep the layer thin and its selectors stable:

- Prefer `getByRole` with an accessible name. It breaks when the accessibility
  breaks, which is a defect you want reported.
- `data-testid` second, for what has no role.
- Never CSS structure or visible copy. Both change for reasons unrelated to
  behaviour.
- Seed state through the API or a fixture, never through the UI. Driving setup
  through the UI makes every test depend on every screen it passes through.
- Wait on a condition, never on a duration. A `sleep` is either flaky or slow,
  and usually both.
