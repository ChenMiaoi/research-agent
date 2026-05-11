---
name: literature-search
description: Deterministic evidence-first literature search for Idea2Repo. Use when planning, running, reviewing, or debugging research paper searches, adapter results, candidate dedupe/ranking, search reports, or generated repo literature artifacts.
---

# Literature Search

Use the deterministic search pipeline before making related-work claims.

## Workflow

1. Build precision, recall, baseline, dataset/metric, venue, and collision queries.
2. Use `src/skills/literature/search.ts` adapters only when network is explicitly allowed.
3. Keep tests mocked; do not depend on real network in unit tests.
4. Dedupe by DOI, arXiv id, normalized title, and author/year/title tuple.
5. Rank by idea match, title/abstract keywords, CCF/venue signal, recency, prominence, and PDF availability.
6. Write candidates to `docs/relative_work/candidates.json` and a report to `docs/relative_work/search_report.md`.

## Guardrails

- Do not invent paper titles, authors, venues, years, identifiers, or URLs.
- Keep unavailable search areas as warnings or manual tasks.
- Prefer DBLP for venue reliability, OpenAlex for recall, Crossref for DOI metadata, arXiv for preprints/PDFs, Semantic Scholar for abstracts, and ACL Anthology for NLP venues.
