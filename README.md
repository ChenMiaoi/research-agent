# Idea2Repo

Idea2Repo turns an early research idea into a CCF-A readiness repository: a strict diagnosis report, scoring artifacts, execution plan, paper skeleton, and reproducible project scaffold.

The implementation is intentionally workflow-first. It does not fabricate references, experimental results, or acceptance claims. Offline runs create verified placeholders and search tasks instead of hallucinated papers.

## Quick Start

```bash
uv run idea2repo "LLM agents need long-term memory compression" \
  --domain "AI/LLM Agent" \
  --output generated_repos/demo
```

The generated repo includes:

- `docs/diagnosis/ccf_a_readiness_report.md`
- raw and revised CCF-A score artifacts
- related-work and claim-evidence matrices
- survey, execution plan, meeting, runtime, and provider notes
- paper LaTeX skeleton
- experiment, data, result, Docker, script, and GitHub scaffolds

Use `--force` only when intentionally regenerating into a non-empty output directory.

## Development

```bash
uv run python -m unittest discover -s tests
```
