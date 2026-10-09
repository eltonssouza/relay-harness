# Red-Green-Refactor: Core TDD Practice

Use this reference during the test-driven development loop.

## 1. Picking the Next Test Case
From your test list, select the case that removes the most uncertainty about the design:
1. **The test that forces the interface**: If naming, parameter shape, or return type is undecided, write this test first to define the contract cleanly.
2. **The test that narrows the input space**: A test that pins a boundary (empty collection, zero, negative number, max size) provides higher signal than another happy path.
3. **The test with a readable failure**: Author tests whose failure messages clearly state what requirement is missing.

## 2. Observing the RED Failure
A test must be verified in its failing state before writing production code:
- The test was executed by the test runner (not skipped or filtered out).
- The test failed for the **stated requirement assertion**, not because of a syntax error, missing import, or broken test fixture.
- The exit code was non-zero.

*A test that has never failed does not prove the implementation works.*

## 3. Implementing GREEN
Write the minimal code needed to pass the assertion:
- Focus solely on making the test pass.
- Avoid premature abstractions, speculative features, or generalized architectures before test pressure demands them.

## 4. REFACTOR with Safety
With all tests green, refine the code:
- Remove duplication (DRY) and improve readability.
- Reorganize functions and clean up naming.
- Run tests after every refactoring move to ensure behavior invariants are preserved.

## Common Anti-Patterns to Avoid
- **Test written after code**: Results in tests that assert what the code happens to do rather than what the specification requires.
- **Assertion that cannot fail**: Asserting `expect(result).toBeTruthy()` on an object that is always defined.
- **Skipped error paths**: Testing only the happy path and leaving timeouts and exceptions untested.
