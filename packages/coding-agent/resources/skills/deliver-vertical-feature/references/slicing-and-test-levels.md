# Cutting the slice, and choosing the level for each test

Load this at steps 1 and 4.

## What makes a slice vertical

A slice is vertical when a real user action produces a real persisted result.
Everything else is a layer with better marketing.

Four tests for a candidate slice:

1. **Can a person do it?** If demonstrating it needs a REST client and a
   database console, it is not a slice yet.
2. **Does it persist?** A flow that ends in memory has not crossed the
   boundary where the interesting failures live.
3. **Is it thin?** One flow, one happy path, one realistic error. If it needs
   three screens, cut again.
4. **Is it useful alone?** If the answer is "once the next slice lands", the
   integration risk has been deferred, which is the one thing this approach
   exists to prevent.

Common false slices:

| Looks like a slice | Actually |
|---|---|
| "The API for feature X" | A horizontal layer. Nothing is exercisable. |
| "The screen for feature X, with mocked data" | A prototype. The boundary is not crossed. |
| "The whole feature, happy path only" | Half a slice. The error path is where the design is wrong. |
| "Feature X behind a flag nobody can turn on" | Unmerged work with extra steps. |

## Which level owns which test

Verify each behaviour once, at the level that owns it. The cost of getting
this wrong is a suite that is slow, brittle, and still misses things.

| Behaviour | Level that owns it | Why not higher |
|---|---|---|
| A domain rule (validation, calculation, state transition) | Unit | Every combination is cheap here and expensive above |
| The contract between client and service (shape, codes, errors) | Integration | The unit level cannot see it; e2e is too slow for the cases |
| Persistence behaviour (constraint, transaction, index use) | Integration, against a real store | A mocked repository verifies your mock |
| The user's flow across screens | One e2e | Enough to prove it is wired; not the place for case coverage |
| Rendering detail, copy, styling | Not a functional test | Assert it and every wording change is a failed build |

**The rule:** if a test would still pass when you break the behaviour it
claims to cover, it is at the wrong level or asserting the wrong thing. If two
tests fail for the same single cause, one of them is redundant - delete the
higher one.
