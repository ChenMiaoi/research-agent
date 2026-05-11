import type { LiteratureAdapterOptions } from "../types.js";
import { candidateId, compact, fetchText, firstUrl, guardedAdapter } from "./common.js";

export async function searchAclAnthology(options: LiteratureAdapterOptions) {
  return guardedAdapter("acl-anthology", options, async () => {
    const url = new URL("https://aclanthology.org/search/");
    url.searchParams.set("q", options.query);
    const html = await fetchText(url.toString(), options);
    return [...html.matchAll(/<a href="(\/\d{4}\.[^"]+\/)">([\s\S]*?)<\/a>/g)].slice(0, options.limit).map((match) => {
      const sourceUrl = `https://aclanthology.org${match[1]}`;
      const title = compact(stripTags(match[2] ?? "")) || "Untitled ACL Anthology paper";
      return {
        candidate_id: candidateId("acl-anthology", sourceUrl),
        title,
        authors: [],
        year: Number(sourceUrl.match(/\/(\d{4})\./)?.[1]) || null,
        ...aclVenueFields(sourceUrl),
        source_urls: firstUrl(sourceUrl),
        pdf_urls: firstUrl(`${sourceUrl}.pdf`),
        retrieval_sources: ["acl-anthology"],
        retrieval_queries: [options.query],
        confidence: "low" as const
      };
    });
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function aclVenueFields(sourceUrl: string): { venue?: string; track_status?: "main_conference" | "workshop" | "short_paper" | "unknown" } {
  const key = (sourceUrl.match(/\/\d{4}\.([^/]+)\//)?.[1]?.toLowerCase() ?? "").replace(/\.\d+$/, "");
  if (!key) return {};
  if (/\b(workshop|ws|w\d+|sigdial|semeval|wmt|blackboxnlp|clinicalnlp|srw|student)\b/.test(key)) return { track_status: "workshop" };
  if (key.includes("findings") || key.includes("short")) return { track_status: "short_paper" };
  if (key.includes("demo") || key.includes("tutorial")) return { track_status: "unknown" };
  if (/^acl-(?:long|main|short|papers)$/.test(key)) return { venue: "ACL", track_status: key.includes("short") ? "short_paper" : "main_conference" };
  if (/^emnlp-(?:main|long|papers)$/.test(key)) return { venue: "EMNLP", track_status: "main_conference" };
  if (/^naacl-(?:main|long|papers)$/.test(key)) return { venue: "NAACL", track_status: "main_conference" };
  return { track_status: "unknown" };
}
