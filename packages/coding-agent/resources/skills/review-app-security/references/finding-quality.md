# What makes a finding actionable, and what makes it noise

Load this when writing up what the review found.

## A finding that can be acted on has five parts

| Part | Why it is not optional |
|---|---|
| **Location** | `file:line`, or the exact request. "Somewhere in the auth flow" is a rumour. |
| **The mechanism** | How the input reaches the sink. Without it, a reviewer cannot tell a real path from a theoretical one. |
| **A reproduction** | The request, the payload, the state. A finding nobody can reproduce gets closed as unreproducible, correctly. |
| **The impact, in terms of this system** | Not "could lead to XSS" - what an attacker gets: whose data, what action, at what scale. |
| **The fix, at the right layer** | Escaping one output fixes one line; encoding at the boundary fixes the class. Say which you are recommending. |

## Rating, and why the rating is a claim too

Rate exploitability and impact separately, then combine. A finding rated
Critical on impact alone, with no reachable path, spends the credibility that
the next real Critical needs. State the assumptions the rating depends on -
"assumes the endpoint is reachable without authentication" is the sentence
that lets a reviewer disagree usefully.

## The classes worth checking deliberately

Walking a list beats remembering, and these are the ones that hide behind a
passing test suite:

- **Authorization on every resource access,** not just authentication at the
  door. The classic defect is a valid session reading someone else's id.
- **Input that reaches a sink through a second hop** - stored, then rendered;
  logged, then replayed into a query.
- **Trust in a client-supplied value that decides authority** - a role in a
  token nobody verified, a price in a form field.
- **Error paths that leak** - stack traces, internal ids, the difference
  between "no such user" and "wrong password".
- **Anything that turns writing into executing later** - a hook, a script
  field, a template, a scheduled job definition.
- **Secrets reachable from the code path being reviewed,** including in logs
  and in what gets sent to a third party.

## The three findings that should not be written

1. **The tool's output, unread.** A scanner line pasted in without checking
   reachability is a task for the reader, not a finding.
2. **The theoretical class with no path.** "This framework has had XSS bugs"
   is background, not a finding.
3. **The style preference wearing a severity.** If it does not change what an
   attacker can do, it belongs in code review, not here.

## Closing the review honestly

Say what was covered and what was not. A review that examined the API and not
the background jobs is a useful review; one that implies it examined
everything is a liability. Name the surfaces left, and who owns them.
