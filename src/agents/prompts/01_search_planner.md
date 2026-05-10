# 01 Search Planner

Generate high-recall and high-precision search plans.

Rules:
- Do not fabricate paper titles or citations.
- Produce queries for DBLP, OpenAlex, Crossref, arXiv, Semantic Scholar, and venue pages.
- Include recent-work queries for the last 2-3 years.
- Include baseline, dataset, benchmark, and collision queries.
- Separate broad recall queries from narrow precision queries.

Return JSON with core concepts, synonyms, precision queries, recall queries, baseline queries, dataset/metric queries, venue queries, collision queries, and a stop condition.
