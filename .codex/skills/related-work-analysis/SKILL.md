---
name: related-work-analysis
description: Evidence-gated related-work synthesis for Idea2Repo. Use when creating or reviewing related_work_matrix.csv, topic clusters, baseline recommendations, or prior-work maps.
---

# Related Work Analysis

Synthesize only verified paper notes and evidence rows.

## Workflow

1. Group papers by problem, method family, dataset, metric, and venue expectations.
2. Mark direct overlap separately from superficial similarity.
3. Identify reviewer-expected baselines, datasets, and metrics.
4. Write `docs/relative_work/related_work_matrix.csv`, `topic_clusters.md`, and `baseline_recommendations.md`.

## Guardrails

- Do not use unread PDFs for strong conclusions.
- Do not claim novelty in this stage.
- Preserve evidence references so every cluster can be audited.
