---
description: Record a hurdle or lasting learning from this session in the project's AGENTS.md
argument-hint: "[what we learned]"
---
Record a lasting learning from this session in the project's agent instructions: $ARGUMENTS

1. Identify the learning. Without an argument, take it from this session: corrections the developer made, constraints they stated (the harness restates them next to the latest message), and problems that took more than one attempt to solve.
2. Keep only what will recur and is not obvious from the code: environment or tool quirks, external service behavior, a decision with its reason, a pattern to follow. Skip one-off details and anything the instructions already say.
3. Read the project's AGENTS.md (at the repository root, unless the project keeps its agent instructions elsewhere) in full. If an entry already covers the same problem, update it instead of adding another.
4. Add the entry under a `## Common hurdles` section, creating it at the end of the file if it does not exist:

   ```markdown
   ### <the symptom, as someone would first notice it>
   - Cause: <why it happens>
   - Solution: <what to do instead>
   - Verify: <the command or check that shows it is handled>
   ```

5. Keep the entry to a few lines. Name where a secret lives, never its value.
6. Show the diff and stop. Do not commit.
