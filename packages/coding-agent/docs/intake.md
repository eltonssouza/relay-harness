# Requirements Intake

Tasks often arrive as one vague phrase ("change the calculation") or as text spread over several pages. An engineer cannot tell what to build, and asking one question at a time takes days. `/intake` reads the task, analyzes the code of the current project, and writes a Word questionnaire with every question the authors need to answer, in words a 12-year-old without technical knowledge understands.

```
/intake alterar cálculo
/intake --out docs/questions.docx see notes/ticket-123.md and https://wiki.example.com/page
```

The questionnaire is written to `.relay/intake/<date>-<title>.docx` unless `--out` names another file. The agent replies with the path, the number of questions, and the main open points.

## How it works

1. **Read the description.** Files, folders and links the description names are read as part of it.
2. **Analyze the code.** The agent searches for the words of the description, their synonyms and translations, and finds every place the request could mean. For "change the calculation" that is every calculation, with the screens, reports, exports and stored data each one touches. What the code answers is not asked.
3. **Find the gaps.** A checklist covers which thing exactly, today versus wanted, inputs, expected results with real examples, rules and exceptions, people affected, ripple effects on other screens and reports, old data (retroactive or not), timing, messages, and how the authors will check the result.
4. **Write the questionnaire.** The agent calls the `intake_questionnaire` tool with the questions. The tool rejects technical words (unless the glossary explains them), code names, file names, folder paths and sentences over 30 words, so the agent rewrites until a lay reader can answer.

For "alterar cálculo" the questionnaire asks, among others: which calculation, offered as choices found in the code; which inputs change; examples of the expected result in a table to fill; whether reports and exports change too; whether past records must be recalculated, and from which date (asked only when the answer to the previous question is yes).

## The document

- The request as received, what was understood, and what the system does today, so the reader can correct mistakes.
- Instructions on how to answer.
- Questions grouped by topic. Each one says why it is asked and, when useful, how it works today.
- Choice questions with ☐ boxes, plus "Other" and "I don't know"; yes/no questions; answer boxes; example tables to fill with real cases.
- Follow-up questions marked "answer only if you answered X in question N", so one round is enough.
- A glossary for the few words that cannot be avoided.

Labels are in English, Portuguese or Spanish, following the language of the task description.

## Using the tool directly

`intake_questionnaire` has `deferred` exposure: it is not declared to the model until `/intake` loads it, so sessions that do not use it pay nothing for it. When [`tool_search`](cli.md#tools) is active, it can also load the tool when you ask for a requirements questionnaire in your own words. Once loaded, the tool stays declared on that branch.

`/intake` also works in print and RPC mode:

```bash
relay -p "/intake alterar cálculo"
```
