# The contract, and the partial failures a service gets wrong by default

Load this at steps 2 and 4.

## What belongs in a contract that has to survive its callers

The contract is everything a caller can observe. Anything observable and
undocumented will be depended on anyway - the only question is whether you
knew.

- **The shape of success:** fields, types, nullability, units. Units in the
  name (`timeout_ms`, `size_bytes`) prevent a class of defect for free.
- **The shape of failure:** a stable error body with a machine-readable code.
  Callers branch on codes; if you only ship prose, they parse the prose.
- **The status codes you actually return,** and what each means here. A 404
  that means "not authorised" is a contract, and a confusing one.
- **Ordering and pagination guarantees.** "Unordered" is a guarantee too, and
  stating it is what lets you change the ordering later.
- **Idempotency:** which operations are safe to repeat, and how a repeat is
  recognised.
- **Limits:** page size, payload size, rate. An unstated limit is discovered
  in production by the caller who exceeded it.
- **How it changes:** the versioning rule and the deprecation notice period.

Two things that are *not* contract and should never leak: the storage schema,
and the internal identifiers of dependencies. Both turn a private decision
into a public one the moment a caller reads them.

## The partial failures a service is wrong about by default

| Case | The default behaviour | What it should do |
|---|---|---|
| Dependency is slow, not down | Waits, holding a connection, until the caller gives up too | Bounded timeout, then a defined outcome the caller can act on |
| Write succeeded, response lost | Client retries, second write applied | Idempotency key so the retry is recognised as the same operation |
| Two of three writes in a sequence succeeded | State is half-applied, nobody notices | Either one transaction, or a compensating action with a record |
| Dependency returns garbage rather than an error | Garbage propagates as success | Validate at the boundary; a malformed response is a failure |
| Retry storm after a recovery | The dependency falls over again immediately | Backoff with jitter, and a cap on concurrent retries |
| Health check calls the dependency | One slow dependency marks every instance unhealthy | Separate liveness from readiness, and say which dependencies count |

## The rule that prevents most of them

**Nothing crosses a boundary without a timeout, and no timeout is undefined
behaviour.** Write the outcome next to the timeout: fail the request, serve
stale, queue it, or degrade to a named fallback. "It times out" is the
question, not the answer.
