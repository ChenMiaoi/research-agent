import csv
import unittest
from io import StringIO

from idea2repo.literature import (
    ArxivSource,
    CrossrefSource,
    DblpSource,
    OpenAlexSource,
    PaperRecord,
    dedupe_records,
    literature_tasks_md,
    references_bib,
    related_work_csv,
    search_literature,
)


class FakeSource:
    name = "fake"

    def __init__(self, records: list[PaperRecord]) -> None:
        self.records = records

    def search(self, query: str, *, limit: int = 10) -> list[PaperRecord]:
        return self.records[:limit]


class LiteratureTests(unittest.TestCase):
    def test_paper_record_requires_traceable_source(self) -> None:
        record = PaperRecord(
            paper_id="bad",
            title="Bad",
            venue="Nowhere",
            year=2025,
            authors=("A",),
            source_url="not-a-url",
            bibtex_key="bad2025",
        )
        self.assertIn("source_url must be absolute", record.validate())

    def test_references_placeholder_when_no_verified_records(self) -> None:
        bib = references_bib([])
        self.assertIn("Do not invent", bib)
        self.assertNotIn("@inproceedings", bib)

    def test_verified_records_generate_bibtex_and_related_matrix(self) -> None:
        record = PaperRecord(
            paper_id="doi:10.1000/test",
            title="Verified Research Agent",
            venue="ICLR",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://doi.org/10.1000/test",
            bibtex_key="lovelace2026verified",
            doi="10.1000/test",
        )
        self.assertEqual(record.validate(), ())
        self.assertIn("@inproceedings{lovelace2026verified", references_bib([record]))
        rows = list(csv.DictReader(StringIO(related_work_csv([record]))))
        self.assertEqual(rows[0]["title"], "Verified Research Agent")
        self.assertEqual(rows[0]["source_url"], "https://doi.org/10.1000/test")

    def test_dedupe_prefers_traceable_identifiers(self) -> None:
        first = PaperRecord(
            paper_id="a",
            title="Same",
            venue="ICLR",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://doi.org/10.1000/test",
            bibtex_key="a",
            doi="10.1000/test",
        )
        second = PaperRecord(
            paper_id="b",
            title="Same",
            venue="ICLR",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://doi.org/10.1000/test",
            bibtex_key="b",
            doi="10.1000/test",
        )
        self.assertEqual(dedupe_records([first, second]), [first])

    def test_dedupe_uses_title_year_author_fallback_across_sources(self) -> None:
        first = PaperRecord(
            paper_id="conf/test/Lovelace26",
            title="Same Research Agent",
            venue="DBLPConf",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://dblp.org/rec/conf/test/Lovelace26",
            bibtex_key="lovelace2026same",
            dblp_key="conf/test/Lovelace26",
        )
        second = PaperRecord(
            paper_id="10.1000/same",
            title="Same Research Agent",
            venue="CrossrefConf",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://doi.org/10.1000/same",
            bibtex_key="lovelace2026samecrossref",
            doi="10.1000/same",
        )
        self.assertEqual(dedupe_records([first, second]), [first])

    def test_dedupe_uses_paper_id(self) -> None:
        first = PaperRecord(
            paper_id="shared-id",
            title="First Title",
            venue="A",
            year=2025,
            authors=("Ada Lovelace",),
            source_url="https://example.test/first",
            bibtex_key="first2025",
        )
        second = PaperRecord(
            paper_id="shared-id",
            title="Second Title",
            venue="B",
            year=2026,
            authors=("Alan Turing",),
            source_url="https://example.test/second",
            bibtex_key="second2026",
        )
        self.assertEqual(dedupe_records([first, second]), [first])

    def test_search_literature_offline_returns_tasks_not_fake_papers(self) -> None:
        records, tasks = search_literature("agent memory", allow_network=False)
        self.assertEqual(records, [])
        self.assertTrue(tasks)
        self.assertIn("Network disabled", literature_tasks_md(tasks))

    def test_search_literature_uses_mocked_source_when_network_allowed(self) -> None:
        record = PaperRecord(
            paper_id="https://openalex.org/W1",
            title="Mocked Paper",
            venue="MockConf",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://openalex.org/W1",
            bibtex_key="lovelace2026mocked",
            openalex_id="https://openalex.org/W1",
        )
        records, tasks = search_literature(
            "agent memory",
            sources=[FakeSource([record])],
            allow_network=True,
        )
        self.assertEqual(records, [record])
        self.assertEqual(tasks, [])

    def test_dblp_source_parses_mocked_response(self) -> None:
        source = DblpSource()
        payload = {
            "result": {
                "hits": {
                    "hit": [
                        {
                            "info": {
                                "key": "conf/test/Lovelace26",
                                "title": "Mock DBLP Paper",
                                "venue": "TestConf",
                                "year": "2026",
                                "url": "https://dblp.org/rec/conf/test/Lovelace26",
                                "authors": {"author": {"text": "Ada Lovelace"}},
                            }
                        }
                    ]
                }
            }
        }
        with unittest.mock.patch("idea2repo.literature._get_json", return_value=payload):
            records = source.search("mock")
        self.assertEqual(records[0].dblp_key, "conf/test/Lovelace26")
        self.assertEqual(records[0].authors, ("Ada Lovelace",))

    def test_openalex_source_handles_null_primary_location(self) -> None:
        payload = {
            "results": [
                {
                    "id": "https://openalex.org/W1",
                    "title": "OpenAlex Paper",
                    "publication_year": 2026,
                    "doi": "https://doi.org/10.1000/openalex",
                    "primary_location": None,
                    "authorships": [{"author": {"display_name": "Ada Lovelace"}}],
                }
            ]
        }
        with unittest.mock.patch("idea2repo.literature._get_json", return_value=payload):
            records = OpenAlexSource().search("mock")
        self.assertEqual(records[0].doi, "10.1000/openalex")
        self.assertEqual(records[0].venue, "")

    def test_crossref_source_parses_mocked_response(self) -> None:
        payload = {
            "message": {
                "items": [
                    {
                        "DOI": "10.1000/crossref",
                        "URL": "https://doi.org/10.1000/crossref",
                        "title": ["Crossref Paper"],
                        "container-title": ["TestConf"],
                        "issued": {"date-parts": [[2026]]},
                        "author": [{"given": "Ada", "family": "Lovelace"}],
                    }
                ]
            }
        }
        with unittest.mock.patch("idea2repo.literature._get_json", return_value=payload):
            records = CrossrefSource().search("mock")
        self.assertEqual(records[0].doi, "10.1000/crossref")
        self.assertEqual(records[0].authors, ("Ada Lovelace",))

    def test_arxiv_source_parses_mocked_response(self) -> None:
        xml = """<?xml version="1.0"?>
<feed>
  <entry>
    <id>https://arxiv.org/abs/2601.00001</id>
    <published>2026-01-01T00:00:00Z</published>
    <title>Arxiv Paper</title>
    <author><name>Ada Lovelace</name></author>
  </entry>
</feed>
"""

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self) -> bytes:
                return xml.encode("utf-8")

        with unittest.mock.patch("urllib.request.urlopen", return_value=FakeResponse()):
            records = ArxivSource().search("mock")
        self.assertEqual(records[0].arxiv_id, "2601.00001")
        self.assertEqual(records[0].authors, ("Ada Lovelace",))


if __name__ == "__main__":
    unittest.main()
