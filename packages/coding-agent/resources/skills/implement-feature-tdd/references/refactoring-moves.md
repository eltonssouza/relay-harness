# Refactoring moves, and the ones that need a test first

Load this at step 5, once the test is green. The precondition is not
negotiable: **the suite is green before the first move and after every move.**
Refactoring on red is editing, and you will not be able to tell which change
broke what.

## Moves that are safe with the current test

These preserve behavior by construction. Make one, re-run, keep going.

| Move | When it earns its place |
|---|---|
| **Rename** | The name lies, is a category (`data`, `info`, `handle`), or needs a comment to be understood. |
| **Extract function** | A block needs a comment to say what it does — the comment is the function's name. |
| **Inline function** | The body says as much as the name did. |
| **Introduce named constant** | A literal appears twice, or once with a meaning the reader has to infer. |
| **Replace nested conditional with guard clauses** | The happy path is indented three levels deep. |
| **Split loop / slide statements** | One loop is doing two things, or a variable is declared far from its use. |

## Moves that need a second test first

Each of these changes an observable contract on some path. If no test covers
that path today, go back to step 2 and write it before making the move.

- **Change a signature** (parameter added, order changed, return shape widened)
  — every caller is a path, and only the tested ones are protected.
- **Replace a conditional with polymorphism** — the branch you are removing is
  a case; if it has no test, you are deleting untested behavior.
- **Introduce or remove a null/absent case** — the absent case is behavior.
- **Change an error into a different error** — callers may branch on the type.
- **Move behavior across a module boundary** — the boundary is the contract the
  dependency rule protects; crossing it is a design change, not a refactor.

## When to stop

Stop when the next move would need a test that does not exist. Stop when you
have made three moves without re-running the suite — go re-run it. Stop when
the change stops being behavior-preserving: that is a feature, and it starts
back at step 1 with its own case on the list.

## The smell that is not worth chasing

Duplication that is *coincidental* — two blocks that look alike today because
the domain happens to line up, not because they express one rule. Unifying
them couples two things that will diverge, and the next change has to
un-unify them first. Ask what rule the duplication expresses; if there is no
single rule, leave both.
