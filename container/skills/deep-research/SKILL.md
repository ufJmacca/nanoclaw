---
name: deep-research
description: Use when asked to perform deep research, multi-source synthesis, or comparative analysis that benefits from delegating sub-questions to sub-agents and merging their findings into one polished report.
---

# Deep Research

## When to use
Use this skill for research tasks that are broad, ambiguous, source-heavy, or time-consuming, especially when the user wants a single synthesized answer rather than a raw dump of notes.

## Core workflow
1. Restate the research question and define the exact deliverable.
2. Split the work into independent sub-questions.
3. Spawn sub-agents for each sub-question.
4. Give each sub-agent a narrow scope, clear output format, and deadline.
5. Wait for the results, then reconcile conflicts and remove duplication.
6. Produce one final report with a short executive summary and the supporting details.

## Delegation rules
- Prefer 2–5 focused sub-agents for most tasks.
- Each sub-agent should investigate one slice only: source collection, fact checking, comparison, counterarguments, timeline, or recommendations.
- Do not pass one sub-agent another sub-agent’s answer unless you need critique or verification.
- If results disagree, call out the disagreement and explain which source or reasoning is stronger.

## Synthesis rules
- Merge overlapping findings into one coherent narrative.
- Separate facts, inferences, and recommendations.
- Cite or link the underlying sources when available.
- Keep the final answer decisive: say what matters, what is uncertain, and what the next best step is.

## Output
- Default to a clean HTML report when the user wants something shareable or file-based.
- Use PDF when the user explicitly asks for it, or when a printable deliverable is more useful.
- Include: title, summary, sections, source list, and an appendix if needed.
- Keep the report readable in Telegram as an attachment.

## Practical notes
- Use sub-agents for breadth; use the main agent for orchestration and synthesis.
- If the user asks for live or recent information, verify with current sources before answering.
- If the task is high-stakes, clearly separate verified facts from inferred conclusions.
