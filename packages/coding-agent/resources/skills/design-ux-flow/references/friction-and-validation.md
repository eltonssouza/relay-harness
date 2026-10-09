# Where friction accumulates, and how to validate without asking users to design

Load this at steps 2 and 5.

## Friction is not uniformly bad

Removing all friction from a destructive action is a defect. Sort friction into
three kinds before removing any of it:

| Kind | Example | Do |
|---|---|---|
| **Accidental** | Re-entering data the system already has; a step that exists because of the schema | Remove |
| **Protective** | Confirming a deletion; re-authenticating before a payment | Keep, and make it proportionate to the consequence |
| **Diagnostic** | A field that catches a real mistake early | Keep, but move it earlier |

The question is never "is this friction" but "what does removing it cost when
the user is wrong".

## Where friction actually accumulates

Not spread evenly - it clusters in five places, and looking at them in order
finds most of it:

1. **The start.** What the user must decide before anything happens. An empty
   state with five equal choices is the most expensive screen in most products.
2. **Re-entry.** Anything typed twice, or typed at all when the system knows
   it.
3. **Mode changes.** Switching from reading to editing, from list to detail.
   Every mode change is a place to lose context and scroll position.
4. **Waiting without a signal.** Not the duration - the absence of an
   indication that anything is happening.
5. **Recovery.** What happens after a mistake. A flow that is pleasant forward
   and impossible backwards is half a flow.

## Validating without asking users to design

Users are experts in their problem and not in your solution. Two rules:

- **Observe a task, do not demo a screen.** Give a real goal ("cancel the order
  you placed yesterday") and watch. Where they hesitate is the finding; what
  they say afterwards is a rationalisation of what they did.
- **Never ask "would you use this" or "which do you prefer".** Both reliably
  produce a polite answer with no predictive value. Ask what they did last time
  they had this problem.

Record three things per session: where they paused, what they said aloud while
paused, and what they did that you did not expect. The third is where the
design was wrong about the user's model.

## What ships out of this skill

A flow, its friction inventory sorted into the three kinds, the feedback and
error-recovery behaviour for each step, and the specific thing the next
validation session should observe. Not a screen - `design-visual-interface`
takes it from here.
