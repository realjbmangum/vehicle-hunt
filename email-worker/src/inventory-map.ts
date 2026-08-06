// Translate an Auto.dev inventory record into the shape the rest of the
// pipeline already speaks.
//
// Split out from inventory.ts on purpose: this is the one piece with a
// contract against someone else's API, so keeping it free of I/O imports
// means it can be unit-tested directly against a captured real response
// (tests/fixtures/autodev-listing.json).
//
// The field paths below were corrected against a live response. The published
// docs were wrong or incomplete in four places that mattered — mileage is
// `retailListing.miles` (not `vehicle.mileage`, which the API rejects
// outright), the dealer name is `retailListing.dealer` as a plain string, the
// photo is `retailListing.primaryImage`, and `vehicle.bodyStyle` is a useless
// "Truck" for every row. Guessing produced 0% coverage on mileage, photo and
// URL; one captured record fixed all of them.

import type { ParsedListing } from "./llm";

const usable = (v: any) => v !== null && v !== undefined && v !== "";

/** Values dealers use to mean "we didn't say". Storing them is worse than null. */
const PLACEHOLDER = /^(unspecified|unknown|other|not specified|n\/?a|none)$/i;

/**
 * Read the first path that yields a usable value.
 *
 * Each candidate is tried two ways, because Auto.dev returns nested objects
 * normally but *flattened dotted keys* when `?select=` is used — so
 * "vehicle.year" is a path into an object in one response and a literal key
 * in the other. Checking the literal key first costs one lookup.
 */
export function pick(obj: any, ...paths: string[]): any {
  for (const path of paths) {
    if (obj && typeof obj === "object" && usable(obj[path])) return obj[path];

    let cur = obj;
    for (const part of path.split(".")) {
      if (cur === null || cur === undefined) break;
      cur = cur[part];
    }
    if (usable(cur)) return cur;
  }
  return null;
}

/** Like pick, but discards dealer placeholder text. */
function pickReal(obj: any, ...paths: string[]): string | null {
  const v = pick(obj, ...paths);
  if (typeof v !== "string") return v ?? null;
  return PLACEHOLDER.test(v.trim()) ? null : v;
}

export function toInt(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function firstPhoto(raw: any): string | null {
  const candidates = [
    pick(
      raw,
      "retailListing.primaryImage",
      "primaryImage",
      "media.primaryPhotoUrl",
      "primaryPhotoUrl",
      "photoUrl",
    ),
    pick(raw, "media.photoUrls", "photoUrls", "photos", "images"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
    if (Array.isArray(c)) {
      for (const item of c) {
        const url = typeof item === "string" ? item : pick(item, "url", "src", "href");
        if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
      }
    }
  }
  return null;
}

/**
 * Cab type from the feed, for the model years the VIN table won't decode.
 *
 * `vehicle.bodyStyle` is deliberately ignored — it reads "Truck" on every
 * Tacoma and says nothing about the cab. `style` and `series` carry the real
 * answer ("Extended Cab Pickup", "SR 2dr Xtracab 4WD 6.1 ft. SB"), and door
 * count is the last resort: a Tacoma with 4 doors is a Double Cab.
 */
export function cabFromFeed(raw: any): string | null {
  const text = [
    pick(raw, "vehicle.style", "style"),
    pick(raw, "vehicle.series", "series"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/double\s*cab|crew\s*cab/.test(text)) return "Double Cab";
  if (/x-?tracab|extra\s*cab|extended\s*cab|access\s*cab|king\s*cab/.test(text)) {
    return "Access Cab";
  }
  if (/regular\s*cab|standard\s*cab/.test(text)) return "Regular Cab";

  const doors = toInt(pick(raw, "vehicle.doors", "doors"));
  if (doors === 4) return "Double Cab";
  if (doors === 2) return "Access Cab";
  return null;
}

/**
 * Bed size from the feed's series string, e.g. "… 4WD 6.1 ft. SB".
 *
 * Read off the measurement rather than the SB/LB abbreviation, which dealers
 * use inconsistently — the sample record says "6.1 ft. SB" for what is
 * unambiguously the long bed. Tacoma beds are ~5.0-5.5 ft (short) or
 * ~6.0-6.2 ft (long), so 5.8 splits them with room on either side.
 */
export function bedFromFeed(raw: any): string | null {
  const series = String(pick(raw, "vehicle.series", "series", "vehicle.style", "style") || "");
  const m = series.match(/(\d+(?:\.\d+)?)\s*ft/i);
  if (!m) return null;
  const feet = Number(m[1]);
  if (!Number.isFinite(feet) || feet <= 0) return null;
  return feet < 5.8 ? "Short" : "Long";
}

/** Map one Auto.dev record onto a ParsedListing. */
export function toParsedListing(raw: any): ParsedListing {
  const city = pickReal(raw, "retailListing.city", "city");
  const state = pickReal(raw, "retailListing.state", "state");

  return {
    year: toInt(pick(raw, "vehicle.year", "year")),
    make: pick(raw, "vehicle.make", "make"),
    model: pick(raw, "vehicle.model", "model"),
    trim: pickReal(raw, "vehicle.trim", "trim"),
    price: toInt(pick(raw, "retailListing.price", "price", "listPrice")),
    mileage: toInt(pick(raw, "retailListing.miles", "miles", "mileage", "odometer")),
    vin: pick(raw, "vin", "vehicle.vin"),
    // Left for the VIN to answer. The feed's own string is a fallback only.
    drivetrain: null,
    cab_type: cabFromFeed(raw),
    bed_size: bedFromFeed(raw),
    color: pickReal(raw, "vehicle.exteriorColor", "exteriorColor", "color"),
    dealer_name: pickReal(raw, "retailListing.dealer", "retailListing.dealerName", "dealer.name"),
    dealer_location: city && state ? `${city}, ${state}` : city || state || null,
    listing_url: listingUrl(raw),
    photo_url: firstPhoto(raw),
  };
}

/**
 * A clickable destination for the truck.
 *
 * `retailListing.vdp` is often an opaque internal reference ("#101711…")
 * rather than a link, so it's only used when it really is one. Otherwise this
 * returns null and src/lib/links.ts falls back to a VIN search — which is
 * reliable now that every swept row has a VIN.
 */
export function listingUrl(raw: any): string | null {
  for (const v of [
    pick(raw, "retailListing.vdp", "vdp", "vdpUrl", "url", "link", "clickoffUrl"),
  ]) {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/**
 * Some dealers advertise a number that isn't the price of the truck — a
 * figure net of a fictitious trade-in bonus or financing rebate, designed to
 * top a sorted list. One dealer in the first sweep listed a 2022 TRD
 * Off-Road with 44k miles at $16,094 against a $38,305 MSRP, and it landed at
 * the top of the watchlist as Grade A/92.
 *
 * Threshold is measured, not guessed. Across 180 real listings within 100
 * miles the LOWEST genuine price-to-MSRP ratio was 0.73 and the median 0.96;
 * the bait listings sat at 0.42. 0.55 leaves a wide margin below anything
 * legitimate — a real bargain is never discarded by this.
 *
 * A tripped listing keeps its row and loses only its price, which then scores
 * as unknown and renders as CALL. Same principle the drivetrain filter
 * follows: an unknown is far cheaper than a confident wrong answer.
 */
const MIN_PRICE_TO_MSRP = 0.55;

export function priceLooksFake(price: number | null, msrp: number | null): boolean {
  if (!price || !msrp || msrp <= 0) return false;
  return price / msrp < MIN_PRICE_TO_MSRP;
}

export function msrpFrom(raw: any): number | null {
  return toInt(pick(raw, "vehicle.baseMsrp", "baseMsrp", "vehicle.msrp", "msrp"));
}

/** The drivetrain string the feed supplied, kept only as a fallback. */
export function feedDrivetrain(raw: any): string | null {
  return pick(raw, "vehicle.drivetrain", "drivetrain", "driveType");
}

/** Free vehicle-history facts the feed includes. Nothing else supplies these. */
export function historyFrom(raw: any): {
  accidents: number | null;
  oneOwner: boolean | null;
  owners: number | null;
  personalUse: boolean | null;
  carfaxUrl: string | null;
  cpo: boolean | null;
} {
  const h = raw?.history ?? {};
  const num = (v: any) => (typeof v === "number" ? v : null);
  const bool = (v: any) => (typeof v === "boolean" ? v : null);
  const carfax = pick(raw, "retailListing.carfaxUrl", "carfaxUrl");
  return {
    accidents: num(h.accidentCount),
    oneOwner: bool(h.oneOwner),
    owners: num(h.ownerCount),
    personalUse: bool(h.personalUse),
    carfaxUrl: typeof carfax === "string" && /^https?:\/\//i.test(carfax) ? carfax : null,
    cpo: bool(pick(raw, "retailListing.cpo", "cpo")),
  };
}

/** Pull the listing array out of whatever envelope the API wraps it in. */
export function rowsFromResponse(json: any): any[] {
  if (Array.isArray(json)) return json;
  return json?.data || json?.records || json?.listings || json?.results || [];
}
