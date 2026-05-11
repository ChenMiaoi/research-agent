---
name: novelty-analysis
description: Skeptical novelty and collision analysis for Idea2Repo. Use when comparing an idea against verified related work, writing novelty_gap_matrix.md, or assessing collision risk.
---

# Novelty Analysis

Compare the idea against verified related work after paper reading.

## Workflow

1. Use only evidence rows with page, quote, and chunk id.
2. Compare problem formulation, setting, method, data, evaluation, theory, and empirical findings.
3. Treat vague integration differences as high collision risk.
4. Write `docs/relative_work/novelty_gap_matrix.md` and `collision_risk.md`.

## Guardrails

- If verified evidence is missing, mark novelty blocked or unknown.
- If prior work solves the core problem, propose a narrower defensible gap.
- Do not reward novelty claims based only on user intent or candidate abstracts.
