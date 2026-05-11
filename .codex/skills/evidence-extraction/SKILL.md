---
name: evidence-extraction
description: Claim-evidence extraction for Idea2Repo research artifacts. Use when building or reviewing claim matrices, evidence rows, paper notes, or downstream scoring inputs that must cite PDF page/quote/chunk ids.
---

# Evidence Extraction

Only promote claims that are backed by verified PDF evidence.

## Workflow

1. Read PDF chunks and manifest records.
2. Extract claims about problem, method, baselines, datasets, metrics, limitations, and relation to the current idea.
3. Keep each row tied to `paper_id`, `page`, `quote`, `chunk_id`, `status`, and confidence.
4. Write `docs/reference/claim_evidence_matrix.csv` and paper note markdown.

## Guardrails

- A quote without a page or chunk id is not verified evidence.
- Do not upgrade candidate metadata into evidence.
- Downstream related work, novelty, and scoring must use verified evidence rows only.
