---
name: incident-response
description: "Use to manage security and production incidents: contain active threats, gather forensic evidence, eradicate vulnerabilities, restore safe operation, and conduct blameless post-mortems."
---

# Skill: incident-response

## When to Use
Apply this skill when an active security incident, data breach, or critical system outage is declared.

## Incident Response Lifecycle

1. **Triage & Assessment**:
   - Confirm the incident scope, affected systems, data sensitivity, and ongoing impact.
   - Classify incident severity (SEV-1 Critical to SEV-3 Minor) and establish communication channels.

2. **Containment**:
   - Stop ongoing unauthorized access or damage immediately: revoke compromised credentials, invalidate active sessions, isolate affected containers/servers, or block malicious IP ranges.
   - Avoid deleting compromised assets immediately: preserve logs, snapshots, and memory state for forensic investigation.

3. **Eradication & Remediation**:
   - Identify the root vulnerability or exploit mechanism.
   - Patch the vulnerable code, redeploy hardened infrastructure, rotate all potentially exposed secrets, and verify that no backdoors remain.

4. **Recovery & Verification**:
   - Restore services from trusted baselines or backups.
   - Monitor system health, error rates, and security telemetry closely to confirm normal operation.

5. **Blameless Post-Mortem & Preventative Actions**:
   - Document a comprehensive timeline: detection, containment, eradication, and recovery.
   - Analyze root causes and systemic contributing factors.
   - Assign preventative action items with explicit owners and deadlines.
