---
name: automate-tests
description: "Use to design and build end-to-end and integration test automation suites (Playwright/API), implement Page Object Models, monitor runtime console and network errors, and enforce release quality gates."
---

# Skill: automate-tests

## When to Use
Apply this skill when authoring automated browser or API tests, establishing regression test suites, catching UI/runtime defects, or configuring merge-blocking quality gates in CI/CD.

## Test Automation Principles

1. **Testing Pyramid Alignment**:
   - Keep Unit tests fast and broad, API/Integration tests comprehensive for business rules, and UI End-to-End tests focused on critical user journeys.
   - Avoid testing low-level algorithmic logic through slow UI automation.

2. **Robust Browser Automation (Playwright)**:
   - Use the Page Object Model (POM) to separate page structure from test assertion logic.
   - Use accessible, resilient selectors (`getByRole`, `getByLabel`, `data-testid`); avoid fragile CSS class paths or XPath.
   - Ensure clean state isolation: seed test data deterministically via API or database fixtures before each test; avoid interdependent test execution order.
   - Rely on auto-waiting assertions (`expect(locator).toBeVisible()`); never use hardcoded sleep pauses (`setTimeout`).

3. **Runtime Defect Detection**:
   - Attach listeners to catch unhandled browser console errors (`page.on('console')`, `page.on('pageerror')`).
   - Monitor network requests (`page.on('requestfailed')`, 4xx/5xx responses) to detect silent background failures.
   - Treat any unhandled client error as a test failure, even if the user flow visually succeeds.

4. **Automated Accessibility & Quality Gates**:
   - Incorporate automated accessibility checks (e.g., `@axe-core/playwright`) into critical view tests.
   - Validate response schemas, status codes, and latency boundaries for API endpoints.
