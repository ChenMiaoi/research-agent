---
name: pdf-reading
description: PDF parsing, page chunking, and evidence note preparation for Idea2Repo. Use when extracting page text, stable chunk ids, paper notes, or PDF reader prompt inputs.
---

# PDF Reading

Parse downloaded PDFs into stable chunks before any analysis.

## Workflow

1. Read `docs/reference/pdf_manifest.json` and process only `downloaded` records.
2. Validate and parse each PDF with the repository parser.
3. Chunk by page or section with stable `chunk_id` values.
4. Write `docs/reference/pdf_chunks.json`.
5. Prepare paper notes in `docs/reference/paper_notes/<paper_id>.md` with page, quote, and chunk id for every important claim.

## Guardrails

- Mark corrupted, missing, or low-text PDFs as incomplete instead of inferring content.
- Extract limitations and negative results, not only strengths.
- Do not let downstream novelty or score use claims without page, quote, and chunk id.
