---
description: Worker implements, verifier checks against the criteria, worker fixes the defects
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "verifier" agent to verify the implementation from the previous step against the acceptance criteria of the original request (use {previous} placeholder, and include the original request)
3. Finally, use the "worker" agent to fix the defects the verifier reported (use {previous} placeholder); if the verdict has no defects, report the verifier's evidence unchanged

Execute this as a chain, passing output between steps via {previous}.
