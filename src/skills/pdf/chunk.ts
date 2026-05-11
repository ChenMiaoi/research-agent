import { join } from "node:path";
import type { PdfManifestRecord } from "./provenance.js";
import { parsePdf } from "./parse.js";
import type { ParsedPdf } from "./parse.js";

export type PdfChunk = {
  chunk_id: string;
  page: number;
  text: string;
};

export function chunkPdf(parsed: ParsedPdf, maxChars = 2200): PdfChunk[] {
  const chunks: PdfChunk[] = [];
  for (const page of parsed.pages) {
    const text = page.text.trim();
    if (!text) continue;
    for (let offset = 0; offset < text.length; offset += maxChars) {
      chunks.push({
        chunk_id: `p${page.page}-c${Math.floor(offset / maxChars) + 1}`,
        page: page.page,
        text: text.slice(offset, offset + maxChars)
      });
    }
  }
  return chunks;
}

export type PdfChunkIndexEntry = PdfChunk & {
  paper_id: string;
};

export async function buildPdfChunkIndex(root: string, manifest: PdfManifestRecord[]): Promise<PdfChunkIndexEntry[]> {
  const entries: PdfChunkIndexEntry[] = [];
  for (const record of manifest) {
    if (record.status !== "downloaded" || !record.pdf_path) continue;
    try {
      const parsed = await parsePdf(join(root, record.pdf_path));
      entries.push(...chunkPdf(parsed).map((chunk) => ({ ...chunk, paper_id: record.paper_id })));
    } catch {
      continue;
    }
  }
  return entries;
}
