---
name: pdf-acquisition
description: Provenance-first public PDF acquisition for Idea2Repo. Use when downloading, validating, hashing, licensing, or reviewing paper PDF manifests and docs/reference/pdfs artifacts.
---

# PDF Acquisition

Acquire PDFs only from public/legal sources and keep failures explicit.

## Workflow

1. Start from verified `PaperCandidate.pdf_urls`.
2. Skip unknown license sources with `skipped_license`; do not download questionable files.
3. Download only when the caller explicitly enabled PDF download and network permission.
4. Validate the file starts as a PDF, parse enough text for title matching, then write it under `docs/reference/pdfs/`.
5. Record `paper_id`, `source_url`, `downloaded_at`, `sha256`, `bytes`, `license_hint`, `title_match_score`, and `status` in `docs/reference/pdf_manifest.json`.

## Guardrails

- A missing or failed PDF must not block the whole pipeline.
- Never fabricate PDF files or hashes.
- Keep tests on tiny fixture PDFs or mocked fetch/parser output.
