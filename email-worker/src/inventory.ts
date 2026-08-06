// Pull Tacoma inventory directly from Auto.dev instead of waiting for a
// dealer's marketing email to mention one.
//
// Why this exists: measured over real mail, alert emails carry a VIN only 25%
// of the time and a drivetrain 30% of the time — a cars.com alert states
// year/trim/price/mileage/colour/city and nothing else. Every gap the tracker
// has been fighting (UNK drivetrain, missing cab, missing bed, no photo) is
// downstream of that one fact. An inventory API returns the VIN on every row,
// and the VIN is what resolves drivetrain, cab and bed for free via vPIC.
//
// It also removes the failure mode that cost the most: 156 of 200 useless
// emails came from a saved search that wasn't scoped to Tacomas. A pull can't
// be misconfigured on someone else's website.
//
// Everything downstream is reused as-is. Listings are mapped onto the same
// `ParsedListing` shape the LLM produces, so filters, VIN decoding, twin
// matching, scoring, R2 photo capture and the digest are all unchanged.

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { HUNT } from "../../hunt.config.ts";
import { upsertListing } from "./db";
import { checkHardFilters, isTargetVehicle, resolveDrivetrain } from "./filters";
import { decodeVins, type VinFacts } from "./vin";
import { capturePhoto } from "./photos";
import {
  toParsedListing,
  feedDrivetrain,
  rowsFromResponse,
  priceLooksFake,
  msrpFrom,
  historyFrom,
} from "./inventory-map";

const API = "https://api.auto.dev/listings";
const SOURCE = "autodev";

/**
 * Page size is capped by plan — 20 on the free Starter tier. Asking for more
 * is not an error, it just gets clamped, so we request the plan maximum and
 * let the server decide.
 */
const PAGE_SIZE = 100;

/**
 * Hard ceiling on pages per sweep.
 *
 * Measured on the original search: a 100-mile radius held 470 matching
 * vehicles, which the API returns ~19 to a page — 25 calls for complete
 * coverage. 30 leaves headroom for roughly 570 before anything is missed, and
 * a daily sweep at that worst case is ~900 calls a month against a 1,000-call
 * free tier. Widen your radius and you will need to raise this.
 *
 * Hitting the ceiling is always REPORTED (`truncated`), never silent.
 */
const MAX_PAGES = 30;

export interface SweepCriteria {
  zip: string;
  distanceMiles: number;
  yearMin: number;
  yearMax: number;
  priceMax: number;
  mileageMax: number;
}

export interface SweepResult {
  requested: SweepCriteria;
  apiCalls: number;
  totalReported: number | null;
  fetched: number;
  truncated: boolean;
  upserted: number;
  isNew: number;
  photosStored: number;
  dropped: Record<string, number>;
  errors: string[];
  /** Populated on a dry run — what would have been written. */
  preview?: Array<Record<string, unknown>>;
  /**
   * One unmapped record, on a dry run. The mapper reads several candidate
   * paths per field because it was written against published docs; this is
   * how you see the paths the API actually uses when a field comes back
   * empty for every row.
   */
  sample?: unknown;
}

/**
 * Mileage is `miles`, not `vehicle.mileage`. The published docs list both, but
 * the API rejects the latter outright:
 *   400 INVALID_PARAMETER "Invalid parameter provided: vehicle_mileage."
 * Note it reports the name underscored, which is how `dropParam` matches it.
 */
function buildParams(c: SweepCriteria, page: number, drop: Set<string>): URLSearchParams {
  const all: Record<string, string> = {
    zip: c.zip,
    distance: String(c.distanceMiles),
    "vehicle.make": "Toyota",
    "vehicle.model": "Tacoma",
    "vehicle.year": `${c.yearMin}-${c.yearMax}`,
    "retailListing.price": `0-${c.priceMax}`,
    miles: `0-${c.mileageMax}`,
    page: String(page),
    limit: String(PAGE_SIZE),
    sort: "updatedAt.desc",
    includes: "total",
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(all)) {
    if (!drop.has(k.replace(/\./g, "_").toLowerCase())) params.append(k, v);
  }
  return params;
}

/** Pull the offending parameter name out of an INVALID_PARAMETER response. */
function invalidParamFrom(body: string): string | null {
  const m = body.match(/Invalid parameter provided:\s*([A-Za-z0-9_.]+)/);
  return m ? m[1].replace(/\./g, "_").toLowerCase() : null;
}

async function fetchPage(
  apiKey: string,
  c: SweepCriteria,
  page: number,
  drop: Set<string>,
  onDrop: (name: string) => void,
): Promise<{ rows: any[]; total: number | null }> {
  let params = buildParams(c, page, drop);
  let res = await fetch(`${API}?${params}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });

  // A single unrecognised filter shouldn't cost the whole sweep. Drop the one
  // the API named and retry once — loudly, because a dropped filter means we
  // pull a wider set than intended (still bounded by MAX_PAGES, and scoring
  // handles anything that slips through).
  if (res.status === 400) {
    const body = await res.text();
    const bad = invalidParamFrom(body);
    if (bad && !drop.has(bad)) {
      drop.add(bad);
      onDrop(bad);
      console.warn(`[sweep] Auto.dev rejected "${bad}" — retrying without it`);
      params = buildParams(c, page, drop);
      res = await fetch(`${API}?${params}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      });
    } else {
      throw new Error(`Auto.dev 400 for ?${params}\n${body.slice(0, 1500)}`);
    }
  }

  if (!res.ok) {
    // The API key travels in the header, not the query string, so echoing the
    // query back is safe — and it's the difference between diagnosing a
    // rejected parameter and guessing at it.
    throw new Error(
      `Auto.dev ${res.status} for ?${params}\n${(await res.text()).slice(0, 1500)}`,
    );
  }
  const json = (await res.json()) as any;
  const total = typeof json?.total === "number" ? json.total : null;
  return { rows: rowsFromResponse(json), total };
}

export async function sweepInventory(
  db: D1Database,
  photos: R2Bucket | null,
  apiKey: string,
  criteria: SweepCriteria,
  opts: { dryRun: boolean },
): Promise<SweepResult> {
  const result: SweepResult = {
    requested: criteria,
    apiCalls: 0,
    totalReported: null,
    fetched: 0,
    truncated: false,
    upserted: 0,
    isNew: 0,
    photosStored: 0,
    dropped: { offModel: 0, excludedColor: 0, twoWheelDrive: 0, incomplete: 0, error: 0 },
    errors: [],
    preview: opts.dryRun ? [] : undefined,
  };

  // 1. Page through the search.
  const rows: any[] = [];
  const droppedParams = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let batch;
    try {
      batch = await fetchPage(apiKey, criteria, page, droppedParams, (name) =>
        result.errors.push(
          `filter "${name}" rejected by Auto.dev and dropped — results are wider than requested`,
        ),
      );
      result.apiCalls++;
    } catch (err: any) {
      result.errors.push(err.message || String(err));
      break;
    }
    if (batch.total !== null) result.totalReported = batch.total;
    rows.push(...batch.rows);
    if (batch.rows.length === 0) break;
    if (page === MAX_PAGES && batch.rows.length > 0) {
      result.truncated = true;
      console.warn(
        `[sweep] stopped at the ${MAX_PAGES}-page ceiling with ${rows.length} rows` +
          `${batch.total ? ` of ${batch.total} reported` : ""} — narrow the criteria or raise MAX_PAGES`,
      );
    }
  }
  result.fetched = rows.length;
  if (opts.dryRun && rows.length) result.sample = rows[0];
  if (rows.length === 0) return result;

  // 2. One batched VIN decode for the whole sweep — every row should have one.
  const listings = rows.map(toParsedListing);
  let facts = new Map<string, VinFacts>();
  try {
    facts = await decodeVins(listings.map((l) => l.vin || ""));
  } catch (err) {
    console.error("[sweep] VIN decode failed", err);
  }

  // 3. Same gauntlet the email path runs, in the same order.
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const f = listing.vin ? facts.get(listing.vin.toUpperCase()) : undefined;

    if (f?.model && !/tacoma/i.test(f.model)) {
      result.dropped.offModel++;
      continue;
    }
    if (!isTargetVehicle(listing) && !f?.model) {
      result.dropped.offModel++;
      continue;
    }
    if (f?.trim && f.trim.length > (listing.trim || "").length) listing.trim = f.trim;
    if (f?.cabType) listing.cab_type = f.cabType;
    if (f?.bedSize) listing.bed_size = f.bedSize;

    // Bait pricing: drop the number, keep the truck. It scores as
    // price-unknown and renders as CALL rather than topping the watchlist.
    const msrp = msrpFrom(rows[i]);
    if (priceLooksFake(listing.price, msrp)) {
      console.warn(
        `[sweep] implausible price $${listing.price} vs MSRP $${msrp} ` +
          `(${listing.year} ${listing.trim}, ${listing.dealer_name}) — storing as unknown`,
      );
      listing.price = null;
      result.dropped.fakePrice = (result.dropped.fakePrice || 0) + 1;
    }

    const drivetrain =
      f?.drivetrain ?? resolveDrivetrain({ ...listing, drivetrain: feedDrivetrain(rows[i]) });

    const filter = checkHardFilters(listing, drivetrain);
    if (filter.rejected) {
      if (filter.reason === "color") result.dropped.excludedColor++;
      else result.dropped.twoWheelDrive++;
      continue;
    }

    if (opts.dryRun) {
      result.preview!.push({
        year: listing.year,
        trim: listing.trim,
        price: listing.price,
        mileage: listing.mileage,
        vin: listing.vin,
        drivetrain,
        drivetrainFrom: f?.drivetrain ? "vin" : drivetrain ? "feed" : null,
        cab: listing.cab_type,
        bed: listing.bed_size,
        color: listing.color,
        dealer: listing.dealer_location,
        dealerName: listing.dealer_name,
        msrp,
        ...historyFrom(rows[i]),
        photo: !!listing.photo_url,
        url: listing.listing_url,
      });
      result.upserted++;
      continue;
    }

    try {
      const up = await upsertListing(db, listing, drivetrain, SOURCE, "api:auto.dev", null, {
        ...historyFrom(rows[i]),
        msrp,
      });
      if (!up) {
        result.dropped.incomplete++;
        continue;
      }
      result.upserted++;
      if (up.isNew) result.isNew++;

      if (photos && listing.photo_url && up.needsPhoto) {
        const stored = await capturePhoto(photos, up.listingId, listing.photo_url);
        if (stored) {
          await db
            .prepare("UPDATE listings SET photos = ? WHERE id = ?")
            .bind(JSON.stringify([stored.path]), up.listingId)
            .run();
          result.photosStored++;
        }
      }
    } catch (err: any) {
      // One bad row must not abandon the sweep.
      result.dropped.error++;
      result.errors.push(`${listing.vin || listing.year}: ${err.message || String(err)}`);
    }
  }

  return result;
}

/**
 * Sweep criteria, from hunt.config.ts. The two env vars are optional
 * overrides so a deployment can widen its radius without a rebuild.
 *
 * Filtering server-side is safe here in a way it is not for email: we control
 * the query, so a vehicle excluded was excluded on purpose rather than lost
 * silently.
 */
export function criteriaFromEnv(env: {
  BUYER_ZIP?: string;
  MAX_DIST_MILES?: string;
}): SweepCriteria {
  return {
    zip: env.BUYER_ZIP || HUNT.location.zip,
    distanceMiles: Number(env.MAX_DIST_MILES) || HUNT.location.radiusMiles,
    yearMin: HUNT.criteria.yearMin,
    yearMax: HUNT.criteria.yearMax,
    priceMax: HUNT.criteria.maxPrice,
    mileageMax: HUNT.criteria.maxMileage,
  };
}
