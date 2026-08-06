// Cross-source duplicate detection.
//
// The same truck reaches us from several platforms, and only some of them
// state a VIN. A cars.com alert gives year/trim/price/mileage/colour and no
// VIN; an AutoTempest alert for the same truck buries the VIN in its link but
// often omits the mileage. Matched on nothing but VIN and listing_url, those
// two arrive as two separate rows — one of which can never learn its own
// drivetrain.
//
// Bridging them is what turns a row with UNK drivetrain into a confirmed 4WD,
// because a VIN is all vPIC needs.

import type { D1Database } from "@cloudflare/workers-types";
import type { ParsedListing } from "./llm";

export interface TwinRow {
  id: number;
  vin: string | null;
  source: string | null;
  status: string | null;
}

/**
 * Why a match was refused. Logged so a source that never matches shows up as
 * a number instead of silently producing duplicates.
 */
export type TwinMiss = "no-key" | "none" | "ambiguous";

export interface TwinResult {
  row: TwinRow | null;
  miss?: TwinMiss;
}

/**
 * Find the row that is the same truck as `parsed`, arriving from a different
 * platform.
 *
 * The key is (year, price, mileage), all three required. That is deliberate
 * and was measured, not assumed: across the 237 VIN-bearing rows in D1,
 * year+price alone collides for 16 groups — four distinct trucks share
 * 2021/$36,998, and dealers cluster hard on price points like $30,998 and
 * $35,998, so trim doesn't break the tie either (all four are SR5s). Adding
 * mileage produces ZERO collisions between distinct VINs. An odometer reading
 * is what makes a truck individual.
 *
 * A listing missing either number is left alone. Merging the wrong two rows
 * silently destroys a real listing, so a miss is always cheaper than a guess.
 */
export async function findTwin(
  db: D1Database,
  parsed: ParsedListing,
): Promise<TwinResult> {
  if (!parsed.year || !parsed.price || !parsed.mileage) {
    return { row: null, miss: "no-key" };
  }

  // A row that already carries a DIFFERENT VIN is a different truck by
  // definition — never merge into it.
  const incomingVin = parsed.vin ? parsed.vin.toUpperCase() : null;

  const { results } = await db
    .prepare(
      `SELECT id, vin, source, status
         FROM listings
        WHERE year = ? AND price = ? AND mileage = ?
          AND status NOT IN ('pass', 'bought')
          AND (vin IS NULL OR vin = ?)
        LIMIT 5`,
    )
    .bind(parsed.year, parsed.price, parsed.mileage, incomingVin)
    .all<TwinRow>();

  if (!results || results.length === 0) return { row: null, miss: "none" };

  // Two open rows already share the key — the assumption behind this whole
  // lookup is broken for them, so touch neither.
  if (results.length > 1) {
    console.warn(
      `[twin] ambiguous: ${results.length} rows match ${parsed.year}/$${parsed.price}/${parsed.mileage}mi — skipping`,
    );
    return { row: null, miss: "ambiguous" };
  }

  return { row: results[0] };
}
