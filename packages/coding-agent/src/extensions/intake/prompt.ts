/** Instructions `/intake` sends to the agent with the task description. */

export const INTAKE_TOOL_NAME = "intake_questionnaire";

export function buildIntakePrompt(description: string, options: { path?: string } = {}): string {
	return `[intake] Refine the task below into a questionnaire for the people who wrote it. Do not implement anything and do not change any file except the questionnaire.

<task-description>
${description}
</task-description>

Work in four steps.

1. Read the description. It may be one vague phrase ("change the calculation"), a long text, or pieces from several pages. If it names files, folders or links you can open, read them all: they are part of the description. List for yourself what it states, what it implies, and what it leaves open.

2. Analyze the source code of this project to ground the questions. Search for the words of the description, their synonyms, and their translations (descriptions are often in Portuguese while code is in English). Find every place the request could mean: for "change the calculation", every calculation that could be it. For each candidate, learn what people see and do: the screens, buttons, fields, reports, exports, emails, messages, imports and integrations it feeds; where its inputs come from; which stored records and past data it touches; who can use it. Read enough to answer from the code everything the code can answer. Never ask the reader what the code already tells you.

3. List the gaps: what an engineer still cannot decide without the authors. Go through this checklist and keep every item that applies:
   - Which thing exactly: the screen, report, rule or calculation meant, offered as options found in the code.
   - Today versus wanted: what happens now, what should happen instead, and why the change is needed.
   - Inputs: what information goes in, where it comes from, and which of it changes.
   - Expected results: real examples with numbers or names, before and after.
   - Rules and exceptions: special cases, limits, rounding, empty or missing values, mistakes the user can make.
   - People: who uses it, who is affected, who may or may not do it.
   - Ripple effects: other screens, reports, exports, documents, notifications or connected systems that show or use the same thing.
   - Old data: whether past records change (retroactive) or only new ones, and from which date.
   - Timing: when it should start, deadlines, whether old and new must work side by side for a while.
   - Messages: texts, warnings or names the user will see.
   - Done: how the authors will check that it is right, and what must not change.

4. Write the questionnaire for people with no technical knowledge, as young as 12 years old:
   - Everyday words. Talk about what people see and do (the "Invoices" screen, the "Monthly sales" report), never about code, files, tables or technical names. If a technical word cannot be avoided, explain it in the glossary.
   - One idea per question, short sentences (at most 25 words). Each question says why it matters ("why"), and, when it helps, how it works today ("context").
   - Prefer choices. Fill options with what the code analysis found, so the reader recognizes them. The document adds "Other" and "I don't know" itself; do not add them.
   - Use kind "example" with columns for calculations and rules, so the reader fills real cases (for example columns "Price", "Discount", "Total you expect").
   - Complete in one round: the authors must not need a second questionnaire. Ask every follow-up now, using onlyIf for questions that depend on an earlier answer (give that earlier question a key). Cover each checklist item that applies.
   - Ask nothing the code or the description already answers. Put those facts in "findings" instead, in plain words, so the reader can correct them.
   - Group questions into sections by topic, in a natural order: what, how it works, special cases, effects, old data, timing, how to check.
   - Write in the language of the task description.

Then call the \`${INTAKE_TOOL_NAME}\` tool with the questionnaire${options.path ? ` and path "${options.path}"` : ""}. It checks the wording and rejects technical words, code names and long sentences: rewrite what it reports and call it again. Finally, reply with the document path, the number of questions, and the main open points, in the language the user writes in.`;
}
