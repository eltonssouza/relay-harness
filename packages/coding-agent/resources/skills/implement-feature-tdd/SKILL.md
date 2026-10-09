---
name: implement-feature-tdd
description: "Use to implement features or fix bugs via Test-Driven Development (TDD): derive test cases from acceptance criteria, observe failing tests (Red), implement minimal passing code (Green), and refactor with safety (Refactor)."
---

# Skill: implement-feature-tdd

## When to Use
Apply this skill when implementing new business logic, adding API endpoints, or fixing defects. When fixing a bug, the fix begins by writing a failing test that reproduces the defect, not by modifying the implementation first.

## The TDD Workflow (Red-Green-Refactor)

1. **Derive Test Scenarios from Acceptance Criteria**:
   - Convert requirements into an ordered test list: happy path, boundary cases, validation rejections, and error paths.
   - Prioritize tests that reduce the most architectural uncertainty first.

2. **Write ONE Failing Test (Red)**:
   - Author a focused test that pins down expected behavior.
   - Run the test suite and **observe the failure**: confirm the test ran, failed for the expected assertion (not due to syntax or compilation error), and produced a non-zero exit code.
   - A test never seen failing provides zero proof of coverage.

3. **Implement the Minimum Code to Pass (Green)**:
   - Write the simplest code that satisfies the failing assertion.
   - Do not speculate on future requirements or over-engineer.
   - Re-run the test suite and verify that all tests pass cleanly.

4. **Refactor for Clean Architecture (Refactor)**:
   - Improve code clarity, eliminate duplication (DRY), and enforce SOLID principles while keeping the test suite green.
   - Re-run tests after every structural adjustment.
   - If a new behavior is needed during refactoring, stop and write a new failing test.

5. **Verification & Mutation Check**:
   - Verify that critical invariants are protected against regressions.
   - Confirm that error paths and timeouts are explicitly covered by dedicated tests.
