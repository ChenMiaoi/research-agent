# Idea2Repo

Idea2Repo turns an early research idea into a CCF-A readiness repository: a strict diagnosis report, scoring artifacts, execution plan, paper skeleton, and reproducible project scaffold.

The implementation is intentionally workflow-first. It does not fabricate references, experimental results, or acceptance claims. Offline runs create verified placeholders and search tasks instead of hallucinated papers.

## Quick Start

```bash
python -m idea2repo "LLM agents need long-term memory compression" --output generated_repos/demo
```

## Development

```bash
python -m unittest discover -s tests
```
