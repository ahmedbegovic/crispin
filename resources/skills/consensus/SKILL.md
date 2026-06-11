---
name: consensus
description: Ask the same question to 2-3 different locally installed model tiers via consult_model, then synthesize their answers into a consensus. Use for judgment calls, tradeoffs, or claims that benefit from a second opinion.
---

You are gathering a multi-model consensus: you will pose the exact same question to 2-3
different local model tiers and synthesize their replies into one reliable answer. Only do
this when the question genuinely benefits from a second opinion — design tradeoffs,
ambiguous bugs, risky decisions, or claims you are unsure about. For routine factual or
mechanical tasks, answer directly and skip the consultation entirely.

## Process

1. Restate the user's question as one self-contained prompt. Inline all needed context
   (code snippets, error text, constraints) — consulted models cannot see this
   conversation; they see only the prompt you send.
2. Call `crispin_web_list_tiers` to see which model tiers are installed. Note each tier's
   label, model id, and estimated RAM.
3. Pick 2-3 tiers. Prefer tiers whose model differs from the one you are running as —
   model diversity is the point. If only one other tier exists, consult just that one.
4. Call `crispin_web_consult_model` with `{ tier, prompt }` for the FIRST tier and wait for
   the reply. IMPORTANT: each call can take several minutes, because the engine swaps
   models in and out of RAM on this 24GB machine. Be patient: never call tiers in
   parallel, never retry just because a call is slow, and never call in a tight loop.
5. Only after the first reply arrives, send the IDENTICAL prompt to the second tier.
   Repeat once more if you chose a third tier.
6. If you pass a `system` string (e.g. "Answer concisely and state your confidence"),
   use the same one for every tier so the replies stay comparable.
7. Read the replies side by side. For each tier, summarize its core position in 1-3
   sentences, attributed to that tier's label and model id.
8. Compare: list concrete points where the models agree, then concrete points where they
   disagree or contradict each other.
9. Form the consensus: state agreed points confidently; where models split, weigh the
   quality of each model's reasoning, pick a side, and mark that part low-confidence.

## Output

Your final reply must contain, in this order:

- **Per-model positions** — one bullet per consulted tier, attributed by tier label and
  model id, summarizing its answer.
- **Agreements** — points where all consulted models align.
- **Disagreements** — points where models split, naming who held which view.
- **Consensus answer** — your synthesized recommendation, explicitly flagging every
  low-confidence area where the models disagreed.
