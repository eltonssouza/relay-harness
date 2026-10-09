# Rule the causes out in this order

Load this at step 2. The order matters: each step is cheaper than the next and
eliminates a class the next one would waste time on.

## 1. Is it actually slow, and for whom?

Get the measurement before the hypothesis. Which statement, what latency, at
what percentile, how often. "The app is slow" and "this statement is slow at
p99 during the nightly job" lead to different work, and only the second is
actionable.

If nobody has the number, stop and measure. Optimising a query nobody proved
slow is the most common wasted day in this skill.

## 2. Is it waiting, or is it working?

This is the fork that decides everything after it.

- **Waiting** - lock contention, connection pool exhaustion, a slow client
  consuming results one row at a time. No index helps. Investigate transaction
  isolation levels and lock scope.
- **Working** - real CPU or I/O reading more rows than the answer needs. Now
  the plan is worth reading.

Skipping this fork is how an index gets added to a table whose problem was a
lock held by an unrelated transaction.

## 3. Read the plan before proposing anything

Look for, in this order:

| In the plan | Usually means |
|---|---|
| A full scan on a large table with a selective predicate | A missing index, or one whose leading column is wrong |
| An index scan reading far more rows than returned | Wrong column order, or a predicate the index cannot use |
| A sort that could have been served by an index order | An ordering opportunity, often free |
| A nested loop over a large outer input | A join order or cardinality estimate problem |
| An estimate far from the actual row count | Stale statistics - fix that before anything else |

The last row is worth checking first in practice: a plan built on wrong
estimates is a plan for a different query.

## 4. Propose the smallest fix the plan justifies

In increasing order of cost to live with:

1. Refresh statistics.
2. Rewrite the predicate so an existing index becomes usable - a function
   wrapped around the column is the usual culprit.
3. Add or reorder one index.
4. Add a covering index.
5. Change the schema.

Stop at the first one that works. Each later step costs more on every write,
every backup, and every future change.

## 5. Prove the gain, and price it

A claimed improvement needs before and after, measured the same way, under the
same conditions - same data volume, same concurrency, same percentile. A gain
measured on an idle database against a hot cache is not a gain.

Then state what it cost: write throughput, storage, and maintenance. An
optimisation with no stated cost was not measured, it was hoped for.
