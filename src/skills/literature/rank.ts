import { loadVenueDatabase } from "../../venues.js";
import type { PaperCandidate } from "./types.js";
import { enrichCandidate, isMainTrackCandidate, resolveVenue } from "./venue.js";

export function rankCandidates(candidates: PaperCandidate[], idea = "", options: { targetVenues?: string[] } = {}): PaperCandidate[] {
  return candidates
    .map((candidate) => enrichCandidate(candidate, { idea, targetVenues: options.targetVenues }))
    .map((candidate) => ({ ...candidate, relevance_score: relevanceScore(candidate, idea) }))
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0) || (b.year ?? 0) - (a.year ?? 0));
}

export function relevanceScore(candidate: PaperCandidate, idea = ""): number {
  const text = `${candidate.title} ${candidate.abstract ?? ""}`.toLowerCase();
  const ideaTerms = terms(idea);
  const semantic = ideaTerms.length ? ideaTerms.filter((term) => text.includes(term)).length / ideaTerms.length : 0.2;
  const keyword = ["baseline", "benchmark", "dataset", "metric", "agent", "security", "system", "evaluation"].filter((term) => text.includes(term)).length / 8;
  const venue = venueSignal(candidate.venue);
  const venueFit = venueMatchSignal(candidate);
  const track = trackSignal(candidate);
  const recency = candidate.year == null ? 0.3 : Math.max(0, Math.min(1, (candidate.year - 2018) / 8));
  const prominence = candidate.doi || candidate.openalex_id || candidate.dblp_key || candidate.semantic_scholar_id ? 0.7 : 0.2;
  const pdf = candidate.pdf_status === "downloaded" || candidate.pdf_status === "available" || candidate.pdf_urls.length ? 1 : 0;
  return round(0.26 * semantic + 0.16 * keyword + 0.11 * venue + 0.12 * venueFit + 0.2 * track + 0.08 * recency + 0.05 * prominence + 0.02 * pdf);
}

function venueSignal(venue: string | undefined): number {
  if (!venue) return 0;
  const resolved = resolveVenue(venue);
  if (resolved?.record.ccf_category === "A") return 1;
  if (resolved?.record.ccf_category === "B") return 0.75;
  if (resolved?.record.ccf_category === "C") return 0.55;
  const normalized = venue.toLowerCase();
  const database = loadVenueDatabase();
  for (const domain of Object.values(database.domains)) {
    for (const name of [...domain.primary_venues, ...domain.secondary_venues]) {
      if (normalized.includes(name.toLowerCase())) return 1;
    }
  }
  return 0.3;
}

function venueMatchSignal(candidate: PaperCandidate): number {
  if (candidate.venue_match === "target") return 1;
  if (candidate.venue_match === "primary") return 0.9;
  if (candidate.venue_match === "secondary" || candidate.venue_match === "ccf_a") return 0.75;
  if (candidate.venue_match === "known") return 0.55;
  return 0.2;
}

function trackSignal(candidate: PaperCandidate): number {
  if (isMainTrackCandidate(candidate)) return 1;
  if (candidate.track_status === "unknown") return 0.45;
  return 0;
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((term) => term.length > 3))].slice(0, 20);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
