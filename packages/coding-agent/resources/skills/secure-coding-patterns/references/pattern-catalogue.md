# The patterns, and the sinks they protect

Load this when applying a control to a specific piece of code.

## Separate code from data, everywhere

Almost every injection class is one mistake: a value crossing into a place
where it is parsed as instructions. The pattern is always the same shape -
never build the instruction as a string.

| Sink | The wrong shape | The pattern |
|---|---|---|
| SQL | String concatenation, or an ORM's raw escape hatch | Parameterised query. Identifiers cannot be parameterised - allow-list them against a fixed set |
| Shell | `exec` with a built string, or `shell: true` | `spawn(file, argvArray, { shell: false })`. This neutralises `;`, `&&`, backticks and pipes even when the argument is fully attacker-controlled |
| HTML | `innerHTML`, `dangerouslySetInnerHTML` | Insert as text. If markup is genuinely required, sanitise with an allow-list and keep CSP as an independent layer |
| Path | Joining user input onto a root | Resolve, then compare by segment. `path.relative` - never a string prefix, which lets `/root-evil` past a check for `/root` |
| Template | User input as the template | User input as template *data*, never as the template itself |
| Deserialisation | Reconstructing arbitrary types | A schema with an explicit field list |
| Log | Interpolating raw user input | Structured fields, so a newline cannot forge an entry |

## Validate on the way in, encode on the way out

Two different jobs, and doing one does not do the other.

- **Validation** happens at the boundary, against an allow-list: type, length,
  format, range, and ownership. Ownership is the one most often missing - "is
  this a valid id" is a different question from "is this id yours".
- **Encoding** happens at the point of use, and depends on the destination.
  The same string is encoded differently for HTML, for an attribute, for a URL
  and for a shell. Encoding once, early, for the wrong destination is worse
  than not encoding.

## Fail closed, and make the safe path the default

On error, on timeout, on anything uncertain: deny. An authorization check that
treats a timeout as allow turns an outage into a bypass.

The default configuration is the secure one; insecurity is an explicit,
recorded opt-in. A safe path that requires remembering a flag is not a control,
it is a suggestion with good intentions.

## The checks that survive contact with a deadline

Ranked by how well they hold when someone is in a hurry:

1. **A type or an API that makes the mistake unrepresentable** - a parameterised
   query builder with no raw escape hatch in reach.
2. **A default in the scaffold** - the safe thing is what you get by doing
   nothing.
3. **A CI check that fails the build** - the wrong thing does not merge.
4. **A review checklist** - depends on attention, which is what a deadline
   removes first.
5. **A written policy alone** - the first deadline breaks it.

If a rule matters, move it up this list.
