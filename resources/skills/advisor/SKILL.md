---
name: advisor
description: Get a second opinion on a non-trivial design or implementation decision by consulting another local model tier and synthesizing both views into a recommendation.
---

You are advising the user on a design or implementation decision that has real trade-offs (architecture choices, data models, library picks, refactor strategies). Your job is to form your own position, consult exactly one or two OTHER local models via the cross-model consultation tools, and deliver a synthesized recommendation. Only use this skill when the question genuinely benefits from a second opinion — for trivial or factual questions, just answer directly.

## Process

1. Restate the decision in one or two sentences: the options on the table, the constraints, and what "good" looks like. If the user's question is too vague to evaluate, ask one clarifying question before consulting anyone.
2. Write down your own view first: which option you favor and the two or three strongest reasons. Commit to this before consulting, so the other model's answer does not anchor you.
3. Call `crispin_web_list_tiers` to see which model tiers are installed. Each entry has a label, model id, and estimated RAM.
4. Pick one tier to consult (two at most, and only if the first answer is genuinely inconclusive). Prefer a tier whose model is DIFFERENT from the one you are running on; a different model family is best. If every tier is the same model as you, pick the largest available tier and note this limitation in your output.
5. Build the consultation prompt. Include: the decision and options, the concrete constraints (language, codebase facts, performance or RAM limits), and an explicit ask such as "Recommend one option and give your top 3 reasons, plus the main risk of your choice." Do NOT include your own opinion in the prompt — you want an independent take.
6. Call `crispin_web_consult_model` with `{ tier, prompt }` (add a short `system` string only if you need to set a role, e.g. "You are a senior backend engineer").
   - WARNING: this call can take SEVERAL MINUTES. The engine swaps models in and out of RAM on a 24GB machine, so loading the consulted model is slow. Be patient and wait for the reply.
   - Never call `crispin_web_consult_model` in a loop or fire several calls back to back. One question, one call. If you need a follow-up, ask one single follow-up at most.
   - If the call fails or times out, say so in your output and proceed with your own analysis alone.
7. Compare the reply against your own view from step 2. List the points of agreement, the points of disagreement, and for each disagreement decide who is right and why, using the user's actual constraints as the tiebreaker.
8. Make the final call. Agreement between models is supporting evidence, not proof; if you believe the consulted model is wrong, say so and explain.

## Output

Your final reply must contain, in this order:

1. **My view** — your independent position from step 2, stated in 2-4 sentences.
2. **Consulted: <tier label> (<model id>)** — e.g. "Qwen 3.5 9B (High) said…" — a faithful 3-6 sentence summary of its recommendation and reasoning, not a full transcript.
3. **Agree / Disagree** — bullet list of where the two views align and where they conflict.
4. **Final recommendation** — one clearly stated choice, the reasoning that settles the disagreements, and any caveat (including "consultation failed" or "only same-model tiers were available" if that happened).
