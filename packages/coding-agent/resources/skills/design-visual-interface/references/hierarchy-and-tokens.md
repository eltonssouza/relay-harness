# Hierarchy with three levers, and a token set that can be consumed

Load this at steps 1 and 4.

## Hierarchy is made of three things

Everything else is decoration. If the hierarchy is not readable with these
three, adding a fourth will not fix it.

1. **Size.** The largest thing is read first. Use a scale with visible steps -
   adjacent sizes that differ by 2px read as a mistake, not a level.
2. **Weight and colour contrast.** A heavier or higher-contrast element is
   read before a lighter one at the same size. This is the lever that works
   when everything must stay the same size.
3. **Space.** Proximity groups; distance separates. Space *inside* a group is
   always smaller than space *around* it - when those invert, the reader sees
   the wrong grouping no matter what the borders say.

The test: squint until the text is unreadable. The order things emerge in is
the hierarchy you actually built. If it is not the order from step 1, fix it
with size, weight or space - not with a border or a background.

## The token set a build step can consume

Hand off named values, not pixel measurements from a picture. A build step can
apply a token; it cannot apply "a bit more space here".

| Group | What to name | Why this granularity |
|---|---|---|
| **Space** | one scale, 5-7 steps (`space-1` ... `space-7`) | Ad-hoc values are how spacing stops meaning anything |
| **Type** | size + line-height + weight per role (`body`, `label`, `heading-1`) | Line-height belongs with size; separating them guarantees drift |
| **Colour** | by role (`surface`, `text`, `text-muted`, `border`, `accent`, `danger`) | Naming by role rather than by hue is what makes a second theme possible |
| **Radius / border** | 2-3 values | More than three and nobody can tell which applies where |
| **Elevation** | 2-3 levels, each with its use | A shadow with no rule becomes decoration on everything |
| **Motion** | duration + easing, 2 pairs | And a `prefers-reduced-motion` alternative |

Two rules:

- **Name by role, not by appearance.** `--danger`, not `--red`. The day the
  danger colour becomes orange, one line changes instead of forty.
- **Every token needs a rule for when it applies.** A token nobody knows when
  to use is a value with a longer name.

## What does not belong in the hand-off

- Pixel positions from a mockup. The implementation reflows; the mockup does
  not.
- A colour used once, unnamed. Either it has a role or it is a mistake.
- "Same as the other screen." Name the token both screens use, or they will
  diverge on the next change.
