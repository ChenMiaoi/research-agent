import { loadVenueDatabase, type VenueDatabase, type VenueRecord } from "../../venues.js";
import type { CandidateCcfGateStatus, CandidateCcfRank, CandidateNoveltyRisk, CandidatePdfStatus, CandidateTrackStatus, CandidateVenueMatch, PaperCandidate } from "./types.js";

export type VenueResolution = {
  record: VenueRecord;
  canonical: string;
  domain: string;
  tier: "primary" | "secondary" | "known";
};

export type CandidateEnrichmentOptions = {
  idea?: string;
  targetVenues?: string[];
  database?: VenueDatabase;
};

const STOPWORD_INITIALS = new Set(["and", "for", "of", "on", "the", "to", "with"]);
const TRACK_QUALIFIER_TOKENS = new Set(["workshop", "workshops", "demo", "demonstration", "short", "paper", "papers", "findings", "companion", "poster", "extended", "abstract"]);

export function enrichCandidates(candidates: PaperCandidate[], options: CandidateEnrichmentOptions = {}): PaperCandidate[] {
  return candidates.map((candidate) => enrichCandidate(candidate, options));
}

export function enrichCandidate(candidate: PaperCandidate, options: CandidateEnrichmentOptions = {}): PaperCandidate {
  const database = options.database ?? loadVenueDatabase();
  const resolution = candidate.venue ? resolveVenue(candidate.venue, database) : null;
  const targetResolutions = (options.targetVenues ?? []).flatMap((venue) => {
    const resolved = resolveVenue(venue, database);
    return resolved ? [resolved] : [];
  });
  const trackStatus = candidate.track_status ?? inferTrackStatus(candidate, resolution?.record);
  const ccfRank = candidate.ccf_rank ?? (resolution?.record.ccf_category as CandidateCcfRank | undefined) ?? "unknown";
  const venueMatch = candidate.venue_match ?? venueMatchFor(resolution, targetResolutions);
  const pdfStatus = candidate.pdf_status ?? inferPdfStatus(candidate);
  const noveltyRisk = candidate.novelty_risk ?? inferNoveltyRisk(candidate, options.idea, venueMatch, trackStatus);
  const mainTrackEligible = isEligibleMainTrack(trackStatus);
  const gate = ccfGateFor({ ccfRank, trackStatus, mainTrackEligible, resolution });
  const provenance = sourceProvenance(candidate, resolution);
  const reason = candidate.reason ?? enrichmentReason({ resolution, venueMatch, trackStatus, ccfRank, pdfStatus, noveltyRisk, gateStatus: gate.status });
  return {
    ...candidate,
    venue: resolution?.canonical ?? candidate.venue,
    ccf_rank: ccfRank,
    venue_match: venueMatch,
    track_status: trackStatus,
    novelty_risk: noveltyRisk,
    pdf_status: pdfStatus,
    main_track_eligible: candidate.main_track_eligible ?? mainTrackEligible,
    ccf_gate_status: candidate.ccf_gate_status ?? gate.status,
    inclusion_reason: candidate.inclusion_reason ?? gate.inclusionReason,
    exclusion_reason: candidate.exclusion_reason ?? gate.exclusionReason,
    source_provenance: candidate.source_provenance ?? provenance,
    reason
  };
}

export function resolveVenue(value: string, database = loadVenueDatabase()): VenueResolution | null {
  const normalized = normalizeVenueAlias(value);
  if (!normalized) return null;
  for (const domain of Object.values(database.domains)) {
    for (const [name, record] of Object.entries(domain.venue_records)) {
      const aliases = venueAliases(name, record);
      if (!aliases.some((alias) => venueAliasMatches(normalized, alias))) continue;
      const tier = domain.primary_venues.includes(name) ? "primary" : domain.secondary_venues.includes(name) ? "secondary" : "known";
      return { record, canonical: name, domain: domain.key, tier };
    }
  }
  return null;
}

export function normalizeVenueAlias(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/\bnips\b/g, "neurips")
    .replace(/\bneurips\b/g, "neurips")
    .replace(/\bs\s*&\s*p\b/g, "security privacy")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function isMainTrackCandidate(candidate: PaperCandidate): boolean {
  return candidate.track_status === "main_conference" || candidate.track_status === "journal";
}

export function isCcfACoreCandidate(candidate: PaperCandidate): boolean {
  return candidate.ccf_gate_status === "included" || (candidate.ccf_rank === "A" && (candidate.main_track_eligible ?? isMainTrackCandidate(candidate)));
}

function venueAliases(name: string, record: VenueRecord): string[] {
  return [
    name,
    record.full_name,
    acronym(record.full_name),
    record.dblp_url.split("/").filter(Boolean).at(-1) ?? ""
  ].map(normalizeVenueAlias).filter(Boolean);
}

function venueAliasMatches(value: string, alias: string): boolean {
  if (!alias) return false;
  if (value === alias) return true;
  const valueTokens = value.split(" ");
  const aliasTokens = alias.split(" ");
  if (aliasTokens.length === 1 && valueTokens.includes(alias) && valueTokens.some((token) => TRACK_QUALIFIER_TOKENS.has(token))) return true;
  if (aliasTokens.length < 2) return false;
  return containsConsecutiveTokens(valueTokens, aliasTokens);
}

function containsConsecutiveTokens(valueTokens: string[], aliasTokens: string[]): boolean {
  if (aliasTokens.length > valueTokens.length) return false;
  for (let index = 0; index <= valueTokens.length - aliasTokens.length; index += 1) {
    if (aliasTokens.every((token, offset) => valueTokens[index + offset] === token)) return true;
  }
  return false;
}

function acronym(value: string): string {
  return value
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter((word) => word && !STOPWORD_INITIALS.has(word.toLowerCase()))
    .map((word) => word[0])
    .join("");
}

function venueMatchFor(resolution: VenueResolution | null, targetResolutions: VenueResolution[]): CandidateVenueMatch {
  if (!resolution) return "unknown";
  if (targetResolutions.some((target) => target.canonical === resolution.canonical)) return "target";
  if (resolution.tier === "primary") return "primary";
  if (resolution.tier === "secondary") return "secondary";
  if (resolution.record.ccf_category === "A") return "ccf_a";
  return "known";
}

function inferTrackStatus(candidate: PaperCandidate, record: VenueRecord | undefined): CandidateTrackStatus {
  const text = `${candidate.venue ?? ""} ${candidate.title}`.toLowerCase();
  if (/\bworkshop|workshops|workshop on|workshop proceedings|workshops at\b/.test(text)) return "workshop";
  if (/\bdemo|demonstration|artifact track|systems track demo\b/.test(text)) return "demo";
  if (/\bshort paper|short papers|findings of|companion proceedings|extended abstract|poster\b/.test(text)) return "short_paper";
  if (record?.venue_type === "journal") return "journal";
  if (record) return "main_conference";
  return "unknown";
}

function inferPdfStatus(candidate: PaperCandidate): CandidatePdfStatus {
  return candidate.pdf_urls.length ? "available" : "unavailable";
}

function inferNoveltyRisk(candidate: PaperCandidate, idea: string | undefined, venueMatch: CandidateVenueMatch, trackStatus: CandidateTrackStatus): CandidateNoveltyRisk {
  const ideaTerms = terms(idea ?? "");
  if (!ideaTerms.length) return "unknown";
  const text = `${candidate.title} ${candidate.abstract ?? ""}`.toLowerCase();
  const overlap = ideaTerms.filter((term) => text.includes(term)).length / ideaTerms.length;
  if (overlap >= 0.6 && (venueMatch === "target" || venueMatch === "primary" || venueMatch === "ccf_a") && trackStatus === "main_conference") return "high";
  if (overlap >= 0.35) return "medium";
  if (overlap > 0) return "low";
  return "unknown";
}

function enrichmentReason(input: {
  resolution: VenueResolution | null;
  venueMatch: CandidateVenueMatch;
  trackStatus: CandidateTrackStatus;
  ccfRank: CandidateCcfRank;
  pdfStatus: CandidatePdfStatus;
  noveltyRisk: CandidateNoveltyRisk;
  gateStatus: CandidateCcfGateStatus;
}): string {
  const venue = input.resolution ? `${input.resolution.canonical} CCF-${input.ccfRank}` : "venue not matched to seed CCF database";
  return `${venue}; ccf_gate=${input.gateStatus}; venue_match=${input.venueMatch}; track_status=${input.trackStatus}; pdf_status=${input.pdfStatus}; novelty_risk=${input.noveltyRisk}`;
}

function ccfGateFor(input: { ccfRank: CandidateCcfRank; trackStatus: CandidateTrackStatus; mainTrackEligible: boolean; resolution: VenueResolution | null }): {
  status: CandidateCcfGateStatus;
  inclusionReason?: string;
  exclusionReason?: string;
} {
  if (input.ccfRank === "A" && input.mainTrackEligible) {
    return {
      status: "included",
      inclusionReason: `${input.resolution?.canonical ?? "matched venue"} is CCF-A and main/full/regular eligible: track_status=${input.trackStatus}.`
    };
  }
  if (input.ccfRank !== "A") {
    return {
      status: "excluded",
      exclusionReason: input.ccfRank === "unknown" ? "Venue is not verified against the CCF seed database." : `Venue is CCF-${input.ccfRank}, not CCF-A.`
    };
  }
  return {
    status: "excluded",
    exclusionReason: `CCF-A venue is not an eligible full/regular track: track_status=${input.trackStatus}.`
  };
}

function sourceProvenance(candidate: PaperCandidate, resolution: VenueResolution | null): string[] {
  const provenance = new Set<string>();
  for (const source of candidate.retrieval_sources) provenance.add(source);
  for (const url of candidate.source_urls) addUrlProvenance(provenance, url);
  for (const url of candidate.pdf_urls) addUrlProvenance(provenance, url);
  if (candidate.dblp_key) provenance.add("dblp");
  if (candidate.doi) provenance.add("publisher");
  if (candidate.openalex_id) provenance.add("openalex");
  if (candidate.arxiv_id) provenance.add("arxiv");
  if (resolution) provenance.add("ccf_seed");
  return [...provenance].sort();
}

function isEligibleMainTrack(trackStatus: CandidateTrackStatus): boolean {
  return trackStatus === "main_conference" || trackStatus === "journal";
}

function addUrlProvenance(provenance: Set<string>, url: string): void {
  const normalized = url.toLowerCase();
  if (normalized.includes("dblp.org")) provenance.add("dblp");
  if (normalized.includes("openalex.org")) provenance.add("openalex");
  if (normalized.includes("semanticscholar.org")) provenance.add("semantic-scholar");
  if (normalized.includes("aclanthology.org")) provenance.add("acl-anthology");
  if (normalized.includes("arxiv.org")) provenance.add("arxiv");
  if (normalized.includes("doi.org") || normalized.includes("dl.acm.org") || normalized.includes("ieeexplore.ieee.org") || normalized.includes("springer.com") || normalized.includes("usenix.org")) provenance.add("publisher");
  if (normalized.includes("openreview.net") || normalized.includes("thecvf.com") || normalized.includes("neurips.cc") || normalized.includes("icml.cc") || normalized.includes("iclr.cc")) provenance.add("venue_page");
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((term) => term.length > 3))].slice(0, 24);
}
