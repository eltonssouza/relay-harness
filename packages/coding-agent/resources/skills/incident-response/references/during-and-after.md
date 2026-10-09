# Running the incident, and the postmortem that changes something

Load this when an incident is open, and again when writing it up.

## The first ten minutes

Order matters here more than thoroughness. Stop the bleeding before
understanding the cause - a root cause found while users are still affected is
a root cause found too late.

1. **Declare it, out loud, in one place.** An undeclared incident is one where
   three people debug the same thing without knowing.
2. **Name the roles.** Who is deciding, who is investigating, who is
   communicating. One person holding all three does none of them.
3. **Mitigate, then diagnose.** Roll back, fail over, disable the feature,
   shed load. Mitigation does not need the cause.
4. **Start the timeline immediately.** What was observed, when, by whom, what
   was changed. Written during, never reconstructed after - reconstruction is
   where the account quietly becomes a story.

## What to keep before it disappears

Evidence has a shelf life, and mitigation destroys some of it. Before
restarting or scaling anything, capture: the logs for the window, the current
configuration, a sample of the failing requests with their ids, and the state
of every dependency. Ten seconds now, or an unanswerable question later.

## Communicating while it is open

Say what is known, what is not, what is being done, and when you will next
update. Then meet that time even when there is nothing new - the silence
between updates is what escalates an incident socially.

Never state a cause during the incident. An early wrong cause outlives the
correction by weeks.

## The postmortem that changes something

Blameless means the analysis asks what made the action reasonable at the time,
not who did it. This is not politeness: an engineer who expects blame reports
less, and the organisation loses its best source of signal.

A postmortem worth the meeting has:

- **A timeline with times,** including when it started versus when it was
  noticed. The gap between those two is usually the most valuable number in
  the document.
- **The contributing factors, plural.** A single root cause is almost always
  the last link, not the cause. Ask what made the failure possible, what made
  it invisible, and what made it hard to fix.
- **Actions with an owner and a date.** An action with neither is a wish.
- **At least one action that is an automated test or a guardrail,** not just documentation. The incident must become an automated regression test or CI guardrail, or it will happen again.

## The question that finds the systemic issue

Not "why did this fail" but **"why did it take that long to notice?"** The
detection gap is where the reliability investment usually pays best, and it is
the question a cause-focused postmortem never asks.
