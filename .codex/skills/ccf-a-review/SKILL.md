---
name: ccf-a-review
description: Strict evidence-based CCF-A readiness review for Idea2Repo. Use when scoring ideas or revised plans, applying cap rules, writing scorecards, or reviewing venue-fit readiness.
---

# CCF-A Review

Score defensively and apply evidence caps before optimism.

## Workflow

1. Score problem importance, novelty, technical depth, experimental design, baseline/dataset/metric strength, venue fit, feasibility, reproducibility, and paper story.
2. Apply strict caps for missing related work, missing PDF reads, fewer than 5 core papers, missing baselines, missing datasets, missing metrics, high collision, engineering-only contribution, missing experiment plan, infeasible resources, missing threat model, missing prototype, and missing ML baselines.
3. Write `docs/diagnosis/ccf_a_strict_scorecard.md`.

## Guardrails

- No verified evidence means no high score.
- Venue-specific requirements can cap total score.
- Keep cap reasons explicit and testable.
