import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaperCandidate } from "../literature/types.js";
import { parsePdfBuffer } from "./parse.js";
import { assertPdf } from "./validate.js";
import { licenseHint, sha256, titleMatchScore, type PdfManifestRecord } from "./provenance.js";

export type PdfAcquireOptions = {
  outputRoot: string;
  allowNetwork?: boolean;
  downloadPdfs?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => string;
};

export async function acquirePdf(candidate: PaperCandidate, options: PdfAcquireOptions): Promise<PdfManifestRecord> {
  const paperId = safePaperId(candidate.candidate_id || candidate.title);
  const sourceUrl = candidate.pdf_urls[0];
  if (!sourceUrl) {
    return { paper_id: paperId, license_hint: "unknown", status: "not_available", reason: "candidate has no PDF URL" };
  }
  const hint = licenseHint(sourceUrl);
  if (hint === "unknown") {
    return { paper_id: paperId, source_url: sourceUrl, license_hint: hint, status: "skipped_license", reason: "PDF URL is not from a recognized public source" };
  }
  if (!options.downloadPdfs) {
    return { paper_id: paperId, source_url: sourceUrl, license_hint: hint, status: "not_available", reason: "PDF download disabled" };
  }
  if (!options.allowNetwork) {
    return { paper_id: paperId, source_url: sourceUrl, license_hint: hint, status: "not_available", reason: "PDF download requires allowNetwork permission" };
  }
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(sourceUrl, { headers: { accept: "application/pdf" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => response.statusText)}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    assertPdf(buffer);
    const parsed = await parsePdfBuffer(buffer, sourceUrl);
    const extractedText = parsed.pages.map((page) => page.text).join("\n");
    const matchScore = titleMatchScore(candidate.title, extractedText);
    if (matchScore < 0.2) throw new Error(`PDF title match too low: ${matchScore}`);
    const relativePath = join("docs", "reference", "pdfs", `${paperId}.pdf`);
    const pdfPath = join(options.outputRoot, relativePath);
    await mkdir(dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, buffer);
    return {
      paper_id: paperId,
      pdf_path: relativePath.split("\\").join("/"),
      pdf_sha256: sha256(buffer),
      source_url: sourceUrl,
      downloaded_at: options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      bytes: buffer.byteLength,
      license_hint: hint,
      title_match_score: matchScore,
      status: "downloaded"
    };
  } catch (error) {
    return {
      paper_id: paperId,
      source_url: sourceUrl,
      license_hint: hint,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function acquirePdfs(candidates: PaperCandidate[], options: PdfAcquireOptions): Promise<PdfManifestRecord[]> {
  const records: PdfManifestRecord[] = [];
  for (const candidate of candidates) records.push(await acquirePdf(candidate, options));
  return records;
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}
