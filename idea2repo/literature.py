"""Verified literature records and no-hallucination artifact helpers."""

from __future__ import annotations

import csv
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from io import StringIO
from typing import Any, Iterable, Protocol


class LiteratureSource(Protocol):
    """Minimal interface for no-key literature sources."""

    name: str

    def search(self, query: str, *, limit: int = 10) -> list["PaperRecord"]:
        ...


@dataclass(frozen=True)
class PaperRecord:
    """A traceable paper record. Do not create one without a real source URL."""

    paper_id: str
    title: str
    venue: str
    year: int
    authors: tuple[str, ...]
    source_url: str
    bibtex_key: str
    abstract: str = ""
    doi: str = ""
    openalex_id: str = ""
    dblp_key: str = ""
    arxiv_id: str = ""
    main_problem: str = "TODO: verify from paper"
    core_method: str = "TODO: verify from paper"
    main_claim: str = "TODO: verify from paper"
    evidence: str = "TODO: verify from paper"
    datasets: str = "TODO: verify from paper"
    baselines: str = "TODO: verify from paper"
    metrics: str = "TODO: verify from paper"
    strengths: str = "TODO: verify from paper"
    weaknesses: str = "TODO: verify from paper"
    limitations: str = "TODO: verify from paper"
    relation_to_current_idea: str = "TODO: analyst review required"
    difference_from_current_idea: str = "TODO: analyst review required"
    collision_risk: str = "Unknown until analyst review"
    useful_for: str = "TODO: analyst review required"

    def validate(self) -> tuple[str, ...]:
        errors: list[str] = []
        if not self.paper_id:
            errors.append("paper_id is required")
        if not self.title:
            errors.append("title is required")
        if self.year < 1800 or self.year > 2100:
            errors.append("year is out of range")
        if not self.authors:
            errors.append("at least one author is required")
        if not self.source_url.startswith(("https://", "http://")):
            errors.append("source_url must be absolute")
        if not self.bibtex_key:
            errors.append("bibtex_key is required")
        if not (self.doi or self.openalex_id or self.dblp_key or self.arxiv_id or self.source_url):
            errors.append("at least one traceable identifier is required")
        return tuple(errors)

    def bibtex(self) -> str:
        safe_title = self.title.replace("{", "").replace("}", "")
        authors = " and ".join(self.authors)
        fields = [
            f"  title = {{{safe_title}}}",
            f"  author = {{{authors}}}",
            f"  year = {{{self.year}}}",
        ]
        if self.venue:
            fields.append(f"  booktitle = {{{self.venue}}}")
        if self.doi:
            fields.append(f"  doi = {{{self.doi}}}")
        fields.append(f"  url = {{{self.source_url}}}")
        return "@inproceedings{" + self.bibtex_key + ",\n" + ",\n".join(fields) + "\n}\n"


class LiteratureSearchError(RuntimeError):
    """Raised when a source cannot complete a network search."""


class OpenAlexSource:
    name = "openalex"

    def search(self, query: str, *, limit: int = 10) -> list[PaperRecord]:
        params = urllib.parse.urlencode({"search": query, "per-page": str(limit)})
        data = _get_json(f"https://api.openalex.org/works?{params}")
        records: list[PaperRecord] = []
        for item in data.get("results", []):
            title = item.get("title") or ""
            if not title:
                continue
            authors = tuple(
                authorship.get("author", {}).get("display_name", "")
                for authorship in item.get("authorships", [])
                if authorship.get("author", {}).get("display_name")
            )
            primary_location = item.get("primary_location") or {}
            source = primary_location.get("source") or {}
            records.append(
                PaperRecord(
                    paper_id=item.get("id", ""),
                    title=title,
                    venue=source.get("display_name", ""),
                    year=int(item.get("publication_year") or 0),
                    authors=authors,
                    source_url=item.get("id", ""),
                    bibtex_key=_bibtex_key(authors, title, item.get("publication_year") or 0),
                    abstract="",
                    doi=_normalize_doi(item.get("doi") or ""),
                    openalex_id=item.get("id", ""),
                )
            )
        return [record for record in records if not record.validate()]


class DblpSource:
    name = "dblp"

    def search(self, query: str, *, limit: int = 10) -> list[PaperRecord]:
        params = urllib.parse.urlencode({"q": query, "format": "json", "h": str(limit)})
        data = _get_json(f"https://dblp.org/search/publ/api?{params}")
        hits = data.get("result", {}).get("hits", {}).get("hit", [])
        records: list[PaperRecord] = []
        for hit in hits:
            info = hit.get("info", {})
            title = _strip_html(info.get("title", ""))
            authors = _dblp_authors(info.get("authors", {}))
            year = int(info.get("year") or 0)
            url = info.get("url", "")
            records.append(
                PaperRecord(
                    paper_id=info.get("key", url),
                    title=title,
                    venue=info.get("venue", ""),
                    year=year,
                    authors=authors,
                    source_url=url,
                    bibtex_key=_bibtex_key(authors, title, year),
                    doi=_normalize_doi(info.get("doi", "")),
                    dblp_key=info.get("key", ""),
                )
            )
        return [record for record in records if not record.validate()]


class CrossrefSource:
    name = "crossref"

    def search(self, query: str, *, limit: int = 10) -> list[PaperRecord]:
        params = urllib.parse.urlencode({"query": query, "rows": str(limit)})
        data = _get_json(f"https://api.crossref.org/works?{params}")
        records: list[PaperRecord] = []
        for item in data.get("message", {}).get("items", []):
            title = " ".join(item.get("title") or [])
            authors = tuple(
                " ".join(part for part in (author.get("given", ""), author.get("family", "")) if part)
                for author in item.get("author", [])
            )
            year_parts = item.get("issued", {}).get("date-parts", [[0]])
            year = int(year_parts[0][0] or 0)
            records.append(
                PaperRecord(
                    paper_id=item.get("DOI", item.get("URL", "")),
                    title=title,
                    venue=" ".join(item.get("container-title") or []),
                    year=year,
                    authors=tuple(author for author in authors if author),
                    source_url=item.get("URL", ""),
                    bibtex_key=_bibtex_key(authors, title, year),
                    doi=_normalize_doi(item.get("DOI", "")),
                )
            )
        return [record for record in records if not record.validate()]


class ArxivSource:
    name = "arxiv"

    def search(self, query: str, *, limit: int = 10) -> list[PaperRecord]:
        params = urllib.parse.urlencode({"search_query": f"all:{query}", "max_results": str(limit)})
        try:
            with urllib.request.urlopen(f"https://export.arxiv.org/api/query?{params}", timeout=15) as response:
                xml = response.read().decode("utf-8", errors="replace")
        except OSError as exc:
            raise LiteratureSearchError(str(exc)) from exc
        records: list[PaperRecord] = []
        for entry in re.findall(r"<entry>(.*?)</entry>", xml, flags=re.DOTALL):
            title = _strip_html(_first_xml(entry, "title")).strip()
            authors = tuple(_strip_html(author).strip() for author in re.findall(r"<name>(.*?)</name>", entry, flags=re.DOTALL))
            url = _first_xml(entry, "id").strip()
            published = _first_xml(entry, "published")
            year = int(published[:4] or 0)
            arxiv_id = url.rsplit("/", 1)[-1]
            records.append(
                PaperRecord(
                    paper_id=arxiv_id,
                    title=title,
                    venue="arXiv",
                    year=year,
                    authors=authors,
                    source_url=url,
                    bibtex_key=_bibtex_key(authors, title, year),
                    arxiv_id=arxiv_id,
                )
            )
        return [record for record in records if not record.validate()]


def dedupe_records(records: Iterable[PaperRecord]) -> list[PaperRecord]:
    seen: set[str] = set()
    deduped: list[PaperRecord] = []
    for record in records:
        keys = _identity_keys(record)
        if seen & keys:
            continue
        seen.update(keys)
        deduped.append(record)
    return deduped


def verified_records(records: Iterable[PaperRecord]) -> list[PaperRecord]:
    """Return only traceable records that pass validation."""

    return [record for record in records if not record.validate()]


def search_literature(
    query: str,
    *,
    sources: Iterable[LiteratureSource] | None = None,
    limit: int = 10,
    allow_network: bool = False,
) -> tuple[list[PaperRecord], list[str]]:
    if not allow_network:
        return [], [f"Network disabled. Search manually: {query}"]
    source_list = list(sources or (OpenAlexSource(), DblpSource(), CrossrefSource(), ArxivSource()))
    records: list[PaperRecord] = []
    tasks: list[str] = []
    for source in source_list:
        try:
            records.extend(source.search(query, limit=limit))
        except (AttributeError, LiteratureSearchError, OSError, ValueError) as exc:
            tasks.append(f"{source.name} search failed for {query}: {exc}")
    return dedupe_records(records)[:limit], tasks


def related_work_csv(records: Iterable[PaperRecord]) -> str:
    rows = [_related_work_header()]
    verified = verified_records(records)
    if not verified:
        rows.append(_placeholder_related_row())
    else:
        rows.extend(_record_to_related_row(record) for record in verified)
    return _csv(rows)


def references_bib(records: Iterable[PaperRecord]) -> str:
    verified = verified_records(records)
    if not verified:
        return "% Add only verified BibTeX entries.\n% Do not invent paper titles, authors, venues, years, or URLs.\n"
    return "\n".join(record.bibtex().strip() for record in verified) + "\n"


def literature_tasks_md(tasks: Iterable[str]) -> str:
    task_list = list(tasks)
    if not task_list:
        task_list = [
            "Add verified papers from DBLP, OpenAlex, Crossref, arXiv, venue pages, or publisher pages.",
            "Record source URLs and BibTeX before using citations in paper text.",
        ]
    return "# Literature Search Tasks\n\n" + "\n".join(f"- {task}" for task in task_list) + "\n"


def _record_to_related_row(record: PaperRecord) -> list[str]:
    return [
        record.paper_id,
        record.title,
        record.venue,
        str(record.year),
        "; ".join(record.authors),
        record.main_problem,
        record.core_method,
        record.main_claim,
        record.evidence,
        record.datasets,
        record.baselines,
        record.metrics,
        record.strengths,
        record.weaknesses,
        record.limitations,
        record.relation_to_current_idea,
        record.difference_from_current_idea,
        record.collision_risk,
        record.useful_for,
        record.source_url,
        record.bibtex_key,
        record.bibtex().replace("\n", "\\n"),
    ]


def _related_work_header() -> list[str]:
    return [
        "paper_id",
        "title",
        "venue",
        "year",
        "authors",
        "main_problem",
        "core_method",
        "main_claim",
        "evidence",
        "datasets",
        "baselines",
        "metrics",
        "strengths",
        "weaknesses",
        "limitations",
        "relation_to_current_idea",
        "difference_from_current_idea",
        "collision_risk",
        "useful_for",
        "source_url",
        "bibtex_key",
        "bibtex",
    ]


def _placeholder_related_row() -> list[str]:
    return [
        "TODO",
        "Add only verified papers",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
        "Unknown until verified",
        "TODO",
        "TODO",
        "TODO",
        "TODO",
    ]


def _csv(rows: list[list[str]]) -> str:
    buffer = StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerows(rows)
    return buffer.getvalue()


def _get_json(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            import json

            return json.loads(response.read().decode("utf-8", errors="replace"))
    except OSError as exc:
        raise LiteratureSearchError(str(exc)) from exc


def _bibtex_key(authors: Iterable[str], title: str, year: int | str) -> str:
    first_author = next(iter(authors), "unknown").split()[-1].lower()
    title_word = next((word for word in re.findall(r"[A-Za-z0-9]+", title.lower()) if len(word) > 2), "paper")
    return re.sub(r"[^a-z0-9]", "", f"{first_author}{year}{title_word}")


def _dblp_authors(raw: dict[str, Any]) -> tuple[str, ...]:
    author = raw.get("author", [])
    if isinstance(author, dict):
        return (author.get("text", ""),)
    if isinstance(author, list):
        return tuple(item.get("text", "") for item in author if item.get("text"))
    return ()


def _strip_html(value: str) -> str:
    return re.sub(r"<[^>]+>", "", value).replace("\n", " ").strip()


def _first_xml(value: str, tag: str) -> str:
    match = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", value, flags=re.DOTALL)
    return match.group(1) if match else ""


def _identity_keys(record: PaperRecord) -> set[str]:
    keys = {
        value.casefold()
        for value in (
            record.paper_id,
            _normalize_doi(record.doi),
            record.openalex_id,
            record.dblp_key,
            record.arxiv_id,
            record.source_url,
        )
        if value
    }
    title_key = "|".join(
        [
            re.sub(r"\W+", " ", record.title.casefold()).strip(),
            str(record.year),
            ";".join(author.casefold() for author in record.authors[:3]),
        ]
    )
    if title_key.strip("|"):
        keys.add(title_key)
    return keys


def _normalize_doi(value: str) -> str:
    value = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if value.casefold().startswith(prefix):
            return value[len(prefix):]
    return value
