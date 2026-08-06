import type { D1Database } from "@cloudflare/workers-types";
import type { ParsedListing } from "./llm";
import { calculateDealScore, type ScoreBreakdown } from "./score";
import type { Drivetrain } from "./filters";
import { findTwin } from "./twins";

export interface UpsertResult {
  listingId: number;
  isNew: boolean;
  /** true when this row has no R2-backed photo yet, so capture should run. */
  needsPhoto: boolean;
  priceDropFrom?: number;
  score: ScoreBreakdown;
  source: string;
}

// Platforms send from ESP subdomains that often DON'T end in their brand
// domain. `bounce.email-carmax.com` and `m.truecarmail.com` were both being
// attributed to "dealer", which made CarMax and TrueCar look dead when they
// were actually sending. Verified against the real domains in raw_emails.
const SOURCE_BY_DOMAIN: Record<string, string> = {
  "carvana.com": "carvana",
  "truecar.com": "truecar",
  "truecarmail.com": "truecar",      // m.truecarmail.com
  "carmax.com": "carmax",
  "email-carmax.com": "carmax",      // bounce.email-carmax.com
  "autotempest.com": "autotempest",
  "cars.com": "cars",
  "autotrader.com": "autotrader",
  "messages.autotrader.com": "autotrader",
  "cargurus.com": "cargurus",
};

export function sourceFromSender(senderEmail: string): string {
  const at = senderEmail.lastIndexOf("@");
  if (at < 0) return "dealer";
  const host = senderEmail.slice(at + 1).toLowerCase();
  for (const [domain, key] of Object.entries(SOURCE_BY_DOMAIN)) {
    if (host === domain || host.endsWith("." + domain)) return key;
  }
  return "dealer";
}

/** Already stored in R2? Then don't re-fetch it. */
function isR2Photo(photos: string | null | undefined): boolean {
  return !!photos && photos.includes("/img/listings/");
}

function joinSources(existing: string | null | undefined, next: string): string {
  const set = new Set((existing || "").split(",").map((s) => s.trim()).filter(Boolean));
  set.add(next);
  return Array.from(set).join(",");
}

/**
 * Vehicle-history facts, which only the inventory feed supplies. Every field
 * is nullable and null means "not stated" — never "clean".
 */
export interface VehicleHistory {
  accidents?: number | null;
  owners?: number | null;
  oneOwner?: boolean | null;
  personalUse?: boolean | null;
  cpo?: boolean | null;
  msrp?: number | null;
  carfaxUrl?: string | null;
}

/** SQLite has no boolean. Preserve false as 0; leave "not stated" as NULL. */
function boolCol(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

export async function upsertListing(
  db: D1Database,
  parsed: ParsedListing,
  drivetrain: Drivetrain | null,
  source: string,
  senderEmail: string,
  rawEmailId: number | null,
  history?: VehicleHistory,
): Promise<UpsertResult | null> {
  // Year is the only hard requirement. A listing with no price ("call for
  // price") is still a truck worth seeing — it scores as price-unknown
  // rather than being thrown away.
  if (!parsed.year) return null;
  if (!parsed.price && !parsed.mileage && !parsed.vin && !parsed.listing_url) return null;

  // Defensive: drop non-http(s) listing_urls before they reach D1.
  if (parsed.listing_url && !/^https?:\/\//i.test(parsed.listing_url)) {
    parsed.listing_url = null;
  }
  // Same for photo_url.
  if (parsed.photo_url && !/^https?:\/\//i.test(parsed.photo_url)) {
    parsed.photo_url = null;
  }

  const score = calculateDealScore({
    year: parsed.year,
    trim: parsed.trim,
    price: parsed.price,
    mileage: parsed.mileage,
    drivetrain,
    cab_type: parsed.cab_type,
    bed_size: parsed.bed_size,
    accident_count: history?.accidents ?? null,
  });

  const now = new Date().toISOString();

  // Dedupe, most reliable key first.
  let existing: any = null;
  if (parsed.vin) {
    existing = await db
      .prepare("SELECT * FROM listings WHERE vin = ?")
      .bind(parsed.vin)
      .first();
  }
  if (!existing && parsed.listing_url) {
    existing = await db
      .prepare("SELECT * FROM listings WHERE listing_url = ? AND year = ?")
      .bind(parsed.listing_url, parsed.year)
      .first();
  }
  // Neither key hit, but the same truck may already be here from another
  // platform under a different URL and no VIN. Matching it means a VIN-less
  // row can finally learn its drivetrain from this email's VIN.
  if (!existing) {
    const twin = await findTwin(db, parsed);
    if (twin.row) {
      existing = await db
        .prepare("SELECT * FROM listings WHERE id = ?")
        .bind(twin.row.id)
        .first();
      if (existing) {
        console.log(
          `[twin] matched id=${existing.id} (${existing.source}) to incoming ${source}` +
            (parsed.vin && !existing.vin ? ` — adopting VIN ${parsed.vin}` : ""),
        );
      }
    }
  }

  if (existing) {
    const priceDrop =
      existing.price && parsed.price && parsed.price < existing.price
        ? (existing.price as number)
        : undefined;
    const newSources = joinSources(existing.source, source);

    let priceHistory: Array<{ price: number; at: string }> = [];
    try {
      priceHistory = existing.price_history ? JSON.parse(existing.price_history) : [];
    } catch {
      priceHistory = [];
    }
    if (parsed.price && existing.price !== parsed.price) {
      priceHistory.push({ price: parsed.price, at: now });
    }

    // A later email often carries what the first one lacked — a photo, the
    // drivetrain, the cab. Previously none of these were ever updated, so a
    // row created from a terse alert stayed incomplete forever.
    const existingPhotos = existing.photos as string | null;
    const mergedPhotos =
      existingPhotos && existingPhotos !== "null"
        ? existingPhotos
        : parsed.photo_url
          ? JSON.stringify([parsed.photo_url])
          : null;

    const shouldRefreshAlert = priceDrop !== undefined; // re-flag for digest on price drop

    await db
      .prepare(
        `UPDATE listings
         SET vin = COALESCE(vin, ?),
             price = COALESCE(?, price), mileage = COALESCE(?, mileage), trim = COALESCE(?, trim),
             dealer_name = COALESCE(?, dealer_name), dealer_location = COALESCE(?, dealer_location),
             listing_url = COALESCE(?, listing_url), color = COALESCE(?, color),
             drivetrain = COALESCE(?, drivetrain), cab_type = COALESCE(?, cab_type),
             bed_size = COALESCE(?, bed_size), photos = ?,
             accident_count = COALESCE(?, accident_count),
             owner_count = COALESCE(?, owner_count),
             one_owner = COALESCE(?, one_owner),
             personal_use = COALESCE(?, personal_use),
             cpo = COALESCE(?, cpo), msrp = COALESCE(?, msrp),
             carfax_url = COALESCE(?, carfax_url),
             source = ?, last_seen_at = ?, price_history = ?,
             deal_score = ?, deal_grade = ?,
             alert_status = CASE WHEN ? = 1 THEN 'pending' ELSE alert_status END,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        parsed.vin,
        parsed.price,
        parsed.mileage,
        parsed.trim,
        parsed.dealer_name,
        parsed.dealer_location,
        parsed.listing_url,
        parsed.color,
        drivetrain,
        parsed.cab_type,
        parsed.bed_size,
        mergedPhotos,
        history?.accidents ?? null,
        history?.owners ?? null,
        boolCol(history?.oneOwner),
        boolCol(history?.personalUse),
        boolCol(history?.cpo),
        history?.msrp ?? null,
        history?.carfaxUrl ?? null,
        newSources,
        now,
        JSON.stringify(priceHistory.slice(-20)),
        score.total,
        score.grade,
        shouldRefreshAlert ? 1 : 0,
        now,
        existing.id,
      )
      .run();

    if (rawEmailId !== null) {
      await db
        .prepare("UPDATE raw_emails SET listing_id = ?, parsed_ok = 1 WHERE id = ?")
        .bind(existing.id, rawEmailId)
        .run();
    }

    return {
      listingId: existing.id as number,
      isNew: false,
      needsPhoto: !isR2Photo(mergedPhotos),
      priceDropFrom: priceDrop,
      score,
      source,
    };
  }

  // Brand new listing.
  const result = await db
    .prepare(
      `INSERT INTO listings
        (year, trim, price, mileage, vin, color, drivetrain, bed_size, cab_type,
         dealer_name, dealer_location, listing_url, photos,
         accident_count, owner_count, one_owner, personal_use, cpo, msrp, carfax_url,
         source, sender_email, ingested_at, last_seen_at,
         price_history, deal_score, deal_grade, alert_status,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'watching', ?, ?)`,
    )
    .bind(
      parsed.year,
      parsed.trim,
      parsed.price,
      parsed.mileage,
      parsed.vin,
      parsed.color,
      // NEVER default this. Storing "4WD" for an email that never said so is
      // what put rear-wheel-drive trucks in the feed wearing a 4WD badge.
      drivetrain,
      parsed.bed_size,
      parsed.cab_type,
      parsed.dealer_name,
      parsed.dealer_location,
      parsed.listing_url,
      parsed.photo_url ? JSON.stringify([parsed.photo_url]) : null,
      history?.accidents ?? null,
      history?.owners ?? null,
      boolCol(history?.oneOwner),
      boolCol(history?.personalUse),
      boolCol(history?.cpo),
      history?.msrp ?? null,
      history?.carfaxUrl ?? null,
      source,
      senderEmail,
      now,
      now,
      JSON.stringify([{ price: parsed.price, at: now }]),
      score.total,
      score.grade,
      now,
      now,
    )
    .run();

  const listingId = Number(result.meta.last_row_id);
  if (rawEmailId !== null) {
    await db
      .prepare("UPDATE raw_emails SET listing_id = ?, parsed_ok = 1 WHERE id = ?")
      .bind(listingId, rawEmailId)
      .run();
  }

  return { listingId, isNew: true, needsPhoto: true, score, source };
}

/**
 * A truck we now reject may already be in D1 from before the filters existed
 * (or from an earlier email that omitted its color/drivetrain). When its alert
 * comes around again, retire the stale row instead of leaving it in the
 * pipeline. Marked 'pass' rather than deleted so VIN dedupe and price history
 * survive.
 */
export async function demoteRejectedListing(
  db: D1Database,
  parsed: ParsedListing,
  reason: "color" | "2wd",
): Promise<number | null> {
  let row: any = null;
  if (parsed.vin) {
    row = await db
      .prepare("SELECT id, status FROM listings WHERE vin = ?")
      .bind(parsed.vin)
      .first();
  } else if (parsed.listing_url) {
    row = await db
      .prepare("SELECT id, status FROM listings WHERE listing_url = ? AND year = ?")
      .bind(parsed.listing_url, parsed.year)
      .first();
  }
  if (!row || row.status === "pass" || row.status === "bought") return null;

  const note =
    reason === "color"
      ? `Auto-passed: excluded exterior colour (${parsed.color ?? "unspecified"}).`
      : "Auto-passed: 2WD/RWD confirmed by a later alert.";

  await db
    .prepare(
      `UPDATE listings
       SET status = 'pass', alert_status = 'dismissed',
           color = COALESCE(?, color), drivetrain = COALESCE(?, drivetrain),
           notes = TRIM(COALESCE(notes || char(10), '') || ?),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      parsed.color,
      reason === "2wd" ? "2WD" : null,
      note,
      row.id,
    )
    .run();

  return row.id as number;
}

export async function recordRawEmail(
  db: D1Database,
  meta: {
    messageId: string | null;
    fromAddr: string;
    toAddr: string;
    subject: string;
    rawBody: string;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO raw_emails (message_id, from_addr, to_addr, subject, raw_body)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      meta.messageId,
      meta.fromAddr,
      meta.toAddr,
      meta.subject,
      meta.rawBody.length > 50_000 ? meta.rawBody.slice(0, 50_000) : meta.rawBody,
    )
    .run();
  return Number(result.meta.last_row_id);
}

export async function markRawEmailError(
  db: D1Database,
  rawEmailId: number,
  error: string,
  llmResponse?: string,
) {
  await db
    .prepare(
      "UPDATE raw_emails SET parsed_ok = 0, parse_error = ?, llm_response = ? WHERE id = ?",
    )
    .bind(error.slice(0, 500), llmResponse?.slice(0, 5000) ?? null, rawEmailId)
    .run();
}
