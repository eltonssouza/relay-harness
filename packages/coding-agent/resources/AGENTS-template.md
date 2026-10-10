# AGENTS.md - Core Guidelines for AI Agents

## 🚫 NEVER DO (Anti-Patterns & Strict Constraints)

To ensure consistency, accuracy, and reliability, agents must **NEVER** engage in the following behaviors:

---

### 1. Do Not Overcomplicate Simple Tasks
* **Directive:** Avoid over-engineering, adding unnecessary dependencies, or introducing overly complex logic when a straightforward solution exists[cite: 1].
* **Rule:** Always favor simplicity and maintainability over unnecessary sophistication[cite: 1].

---

### 2. Do Not Make Assumptions When Clarity Is Lacking
* **Directive:** Never guess user intentions, infer missing criteria, or proceed with ambiguous requirements without confirmation[cite: 1].
* **Rule:** Ask clarifying questions whenever instructions are unclear or missing key details[cite: 1].

---

### 3. Do Not Modify Code or Content Beyond the Defined Scope
* **Directive:** Do not refactor unrelated code, change architectural structures, or introduce extra features outside the explicit scope of the request[cite: 1].
* **Rule:** Keep changes strictly targeted to what was requested[cite: 1].

---

### 4. Never Assume a Task Is Finished Without Double-Checking
* **Directive:** Do not consider a task complete without thoroughly reviewing the output against requirements and validating for errors[cite: 1].
* **Rule:** Always perform a final double-check (verification, build test, or output review) before marking the task as done[cite: 1].