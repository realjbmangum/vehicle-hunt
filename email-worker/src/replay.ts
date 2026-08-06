// Dry-run the ingest pipeline over emails already in `raw_emails`.
//
// Every parser change until now has been shipped on faith and judged days
// later by whether new rows looked better. There are 400 real emails sitting
// in D1 — this runs a candidate parser over them and reports exactly which
// stage each vehicle died at, without writing anything.
//
// Nothing here touches `listings`. It is safe to run against production.

import type { D1Database } from "@cloudflare/workers-types";
import { parseEmailWithClaude, type ParsedListing } from "./llm";
import { checkHardFilters, isTargetVehicle, resolveDrivetrain } from "./filters";
import { decodeVins, isValidVin, vinFromUrl, type VinFacts } from "./vin";

/** Where a vehicle stopped. Mirrors the real ingest order in index.ts. */
export type Stage =
  | "kept"
  | "vin-not-tacoma"
  | "not-tacoma"
  | "color"
  | "2wd"
  | "incomplete";

export interface ReplayVehicle {
  stage: Stage;
  year: number | null;
  trim: string | null;
  price: number | null;
  mileage: number | null;
  vin: string | null;
  vinSource: "email" | "url" | null;
  drivetrain: string | null;
  drivetrainSource: "vin" | "email" | null;
  cab: string | null;
  bed: string | null;
  color: string | null;
  photo: boolean;
  url: string | null;
}

export interface ReplayEmail {
  id: number;
  from: string;
  subject: string;
  receivedAt: string;
  bodyChars: number;
  kind: string;
  vehicles: ReplayVehicle[];
  error?: string;
}

/** What the row would need to survive `upsertListing`. */
function wouldPersist(l: ParsedListing): boolean {
  if (!l.year) return false;
  return !!(l.price || l.mileage || l.vin || l.listing_url);
}

export async function replayEmail(
  db: D1Database,
  apiKey: string,
  id: number,
): Promise<ReplayEmail> {
  const row = await db
    .prepare(
      "SELECT id, from_addr, subject, received_at, raw_body FROM raw_emails WHERE id = ?",
    )
    .bind(id)
    .first<any>();

  if (!row) throw new Error(`raw_email ${id} not found`);

  const base = {
    id: row.id as number,
    from: row.from_addr as string,
    subject: (row.subject as string) || "",
    receivedAt: row.received_at as string,
    bodyChars: ((row.raw_body as string) || "").length,
  };

  let parsed;
  try {
    const out = await parseEmailWithClaude(apiKey, row.raw_body || "", base.subject);
    parsed = out.result;
  } catch (err: any) {
    return { ...base, kind: "error", vehicles: [], error: err.message || String(err) };
  }

  const listings = parsed.listings || [];

  // Same VIN recovery and batch decode the live path uses.
  const vinSources = new Map<ParsedListing, "email" | "url" | null>();
  for (const l of listings) {
    if (isValidVin(l.vin)) {
      vinSources.set(l, "email");
    } else {
      const recovered = vinFromUrl(l.listing_url);
      if (recovered) {
        l.vin = recovered;
        vinSources.set(l, "url");
      } else {
        vinSources.set(l, null);
      }
    }
  }

  let facts = new Map<string, VinFacts>();
  try {
    facts = await decodeVins(listings.map((l) => l.vin || ""));
  } catch {
    // Decoder outage just means the email's own words are all we report.
  }

  const vehicles: ReplayVehicle[] = listings.map((l) => {
    const f = l.vin ? facts.get(l.vin.toUpperCase()) : undefined;
    const drivetrain = f?.drivetrain ?? resolveDrivetrain(l);
    const cab = f?.cabType ?? l.cab_type;
    const bed = f?.bedSize ?? l.bed_size;

    let stage: Stage = "kept";
    if (f?.model && !/tacoma/i.test(f.model)) stage = "vin-not-tacoma";
    else if (!isTargetVehicle(l) && !f?.model) stage = "not-tacoma";
    else {
      const filter = checkHardFilters(l, drivetrain);
      if (filter.rejected) stage = filter.reason === "color" ? "color" : "2wd";
      else if (!wouldPersist(l)) stage = "incomplete";
    }

    return {
      stage,
      year: l.year,
      trim: l.trim,
      price: l.price,
      mileage: l.mileage,
      vin: l.vin,
      vinSource: vinSources.get(l) ?? null,
      drivetrain,
      drivetrainSource: f?.drivetrain ? "vin" : drivetrain ? "email" : null,
      cab,
      bed,
      color: l.color,
      photo: !!l.photo_url,
      url: l.listing_url,
    };
  });

  return { ...base, kind: parsed.kind, vehicles };
}

export interface ReplaySummary {
  emails: number;
  vehicles: number;
  byStage: Record<string, number>;
  /** Field coverage across vehicles that survived every filter. */
  keptCoverage: Record<string, number>;
  errors: Array<{ id: number; error: string }>;
  details?: ReplayEmail[];
}

/**
 * Replay a batch. Sequential on purpose — this competes with live email
 * ingestion for the same worker and the same API key, and finishing a minute
 * later is free while rate-limiting the real pipeline is not.
 */
export async function replayBatch(
  db: D1Database,
  apiKey: string,
  opts: { ids?: number[]; since?: string; limit: number; verbose: boolean },
): Promise<ReplaySummary> {
  let ids = opts.ids;
  if (!ids) {
    const { results } = await db
      .prepare(
        `SELECT id FROM raw_emails
          WHERE (? IS NULL OR received_at >= ?)
          ORDER BY id DESC LIMIT ?`,
      )
      .bind(opts.since ?? null, opts.since ?? null, opts.limit)
      .all<{ id: number }>();
    ids = (results || []).map((r) => r.id);
  }

  const summary: ReplaySummary = {
    emails: 0,
    vehicles: 0,
    byStage: {},
    keptCoverage: {
      price: 0,
      mileage: 0,
      vin: 0,
      vinFromUrl: 0,
      drivetrain: 0,
      drivetrainFromVin: 0,
      cab: 0,
      bed: 0,
      color: 0,
      photo: 0,
      url: 0,
    },
    errors: [],
    details: opts.verbose ? [] : undefined,
  };

  for (const id of ids) {
    let result: ReplayEmail;
    try {
      result = await replayEmail(db, apiKey, id);
    } catch (err: any) {
      summary.errors.push({ id, error: err.message || String(err) });
      continue;
    }
    summary.emails++;
    if (result.error) summary.errors.push({ id, error: result.error });
    if (opts.verbose) summary.details!.push(result);

    for (const v of result.vehicles) {
      summary.vehicles++;
      summary.byStage[v.stage] = (summary.byStage[v.stage] || 0) + 1;
      if (v.stage !== "kept") continue;
      const c = summary.keptCoverage;
      if (v.price !== null) c.price++;
      if (v.mileage !== null) c.mileage++;
      if (v.vin) c.vin++;
      if (v.vinSource === "url") c.vinFromUrl++;
      if (v.drivetrain) c.drivetrain++;
      if (v.drivetrainSource === "vin") c.drivetrainFromVin++;
      if (v.cab) c.cab++;
      if (v.bed) c.bed++;
      if (v.color) c.color++;
      if (v.photo) c.photo++;
      if (v.url) c.url++;
    }
  }

  return summary;
}
