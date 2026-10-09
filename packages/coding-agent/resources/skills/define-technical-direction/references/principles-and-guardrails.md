# Principles that constrain, guardrails that survive

Load this at steps 3 and 5.

## A principle you cannot violate is not a principle

Test every candidate principle by asking: **what real proposal does this rule
out?** If nothing, delete it.

| Not a principle | Why | A principle instead |
|---|---|---|
| "Prefer simplicity" | Nobody proposes complexity on purpose. | "A new runtime needs a named owner and an on-call rota before it ships." |
| "Security is everyone's job" | Assigns responsibility to no one. | "Any endpoint handling personal data fails closed on an authorisation error." |
| "Use the right tool for the job" | Permits everything. | "Data stores come from the supported set; anything else needs an ADR and a migration plan." |
| "Build for scale" | Scale is not a direction. | "A service designs for 10x current peak and no further; beyond that, re-decide." |

A good principle is uncomfortable at least once a quarter. If yours never
blocks anything, it is describing what people already do.

## The four kinds of guardrail, by what they cost to sustain

Prefer the cheapest one that actually holds. Most directions fail by choosing
the most expensive.

| Guardrail | Holds because | Sustaining cost |
|---|---|---|
| **Default in the scaffold** | The right way is what you get when you do nothing. | Lowest. Decays only when the scaffold ages. |
| **Automated check in CI** | The wrong way does not merge. | Low, but every false positive spends credibility. |
| **Review checkpoint** | A human looks. | Medium, and it scales with headcount, not systems. |
| **Written policy alone** | People remember and choose to comply. | Highest, and the first deadline breaks it. |

A policy with no scaffold default and no check is a wish with a document
number. If a rule matters, move it up this table.

## Measuring adoption without measuring activity

Adoption and outcome are different questions and need different measures.

- **Adoption:** what fraction of the estate is on the paved road? Count
  systems, not commits. Count the ones that opted out too, and why - the
  opt-out reasons are the best feedback the direction will get.
- **Outcome:** did the ranked driver from step 1 actually move? Deployment
  frequency, lead time, change failure rate, time to restore - the four that
  resist gaming better than most.

Two failure modes worth naming in advance:

1. **Adoption without outcome.** Everyone migrated and nothing improved. The
   direction was wrong; the honest response is to say so, not to raise the
   adoption target.
2. **Local optimisation.** One team's metric improves by pushing work over a
   boundary. Measure at the boundary that the business cares about, not at the
   one the team owns.
