# Evaluating options against scenarios (ATAM-lite)

Load this at step 3. The point of a scenario is to make two options give
different answers. A scenario every option satisfies has told you nothing and
cost you a meeting.

## The shape of a usable scenario

Six parts, and the ones people drop are the ones that make it discriminating:

| Part | Example | What dropping it costs |
|---|---|---|
| **Source** | an authenticated user | you cannot tell trusted load from hostile |
| **Stimulus** | submits a 40 MB import | "a request" is not a stimulus |
| **Artifact** | the import service | the scenario now applies to everything |
| **Environment** | during the nightly batch window | peak and quiet are different systems |
| **Response** | the import is accepted and queued | "it works" is not a response |
| **Measure** | p99 under 2s, zero rows lost | **this is the part that discriminates** |

Without the measure, every option "supports" the scenario.

## Running the evaluation

1. Take the top two ranked quality attributes. Write two scenarios each.
2. For every option, answer each scenario with a mechanism - how, not whether.
   "Event-driven handles it" is not an answer; "the queue absorbs the burst, so
   p99 is bounded by consumer throughput rather than producer rate" is.
3. Mark, per scenario, which option wins and by how much.
4. Where an option wins one attribute and loses another you have found the real
   trade-off. That sentence goes into the ADR verbatim.

## Sensitivity and trade-off points

- A **sensitivity point** is a decision one attribute depends on sharply -
  change it and that attribute moves a lot.
- A **trade-off point** is a decision two ranked attributes depend on in
  opposite directions.

Every trade-off point belongs in the ADR's consequences. One nobody wrote down
becomes an argument six months later with no record of who accepted what.

## The four ways this gets faked

| Fake | Tell |
|---|---|
| **One option dressed as three** | Two "options" differ only in a library choice. |
| **Scenarios written after the winner was picked** | Every scenario favours the same option and none names a measure. |
| **The straw man** | One option is obviously unacceptable and exists to make the choice look considered. |
| **No losing side** | The recommendation has no stated downside. Every real decision costs something. |

## When to skip this entirely

The decision is cheap to reverse and touches one module. Then the evaluation
costs more than the mistake would. Record a one-line ADR with rationale and move on.
