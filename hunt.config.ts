/**
 * The one file you edit to point this at your own search.
 *
 * Everything below feeds the whole pipeline: the LLM extraction prompt, the
 * hard reject filters, the inventory API sweep, the scoring math and the
 * dashboard chrome. Nothing else in the codebase hardcodes a vehicle, a price
 * or a location — if you find something that does, it's a bug.
 *
 * The values shipped here describe the search this was originally built for
 * (a used Toyota Tacoma) because a working example beats an empty template.
 * Change them.
 */

export interface HuntConfig {
  vehicle: VehicleConfig;
  criteria: CriteriaConfig;
  location: LocationConfig;
  exclude: ExcludeConfig;
  notify: NotifyConfig;
  scoring: ScoringConfig;
}

export interface VehicleConfig {
  /** Shown in the UI, e.g. "Toyota Tacoma". */
  label: string;
  make: string;
  model: string;
  /**
   * Lowercase substrings that identify this model in free text or a URL.
   * Alert emails routinely omit make and model entirely, so these are also
   * matched against the listing URL.
   */
  modelAliases: string[];
  /**
   * Trim names unique enough to imply the model when the email says nothing
   * else. Keep these tight — a generic token like "limited" will happily
   * match a different manufacturer's truck.
   */
  trimHints: RegExp;
  /** Trims never sold in two-wheel drive, so 4WD can be safely inferred. */
  fourWheelDriveOnlyTrims: RegExp[];
  /** Body-style vocabulary the extractor should use. Order is not meaningful. */
  cabTypes: string[];
  bedSizes: string[];
}

export interface CriteriaConfig {
  yearMin: number;
  yearMax: number;
  maxMileage: number;
  maxPrice: number;
  /** Set null to accept any drivetrain. "2WD" listings are hard-rejected when this is "4WD". */
  requiredDrivetrain: "4WD" | "AWD" | null;
  preferredCabType: string | null;
  preferredBedSize: string | null;
}

export interface LocationConfig {
  zip: string;
  radiusMiles: number;
  /** Free text for the dashboard header, e.g. "Austin, TX". */
  label: string;
  /** Optional decimal degrees for the header readout. Null hides it. */
  latitude: number | null;
  longitude: number | null;
}

export interface ExcludeConfig {
  /**
   * Colours you will not consider, as lowercase regexes matched against the
   * exterior colour only. Manufacturers rarely write the plain word — Toyota
   * writes "Super White", "Blizzard Pearl", "Wind Chill Pearl", "Ice Cap" —
   * so list the marketing names, not just the colour.
   *
   * Empty array = no colour is rejected.
   */
  colorPatterns: RegExp[];
}

export interface NotifyConfig {
  /** Where the daily digest is sent. */
  buyerEmail: string;
  /** Verified sender address on your domain. */
  digestFrom: string;
  /** The address your saved-search alerts are pointed at. */
  ingestEmail: string;
  /**
   * Public base URL of the deployed worker, used to serve captured photos out
   * of R2. Update after your first `wrangler deploy` prints the URL.
   */
  photoBaseUrl: string;
}

export interface ScoringConfig {
  /**
   * Price at or below which the price component scores full marks. Set this
   * near the realistic floor of the market you're shopping, not to zero, or
   * every listing scores the same.
   */
  priceFloor: number;
  /**
   * Trim ladder, best first: [pattern, points, display name]. Points are
   * out of the trim component's maximum (10 by default). A listing matching
   * nothing here scores zero for trim, which is fine.
   */
  trimScores: Array<[RegExp, number, string]>;
  /** Points per model year. Years absent score zero. */
  yearScores: Record<number, number>;
}

export const HUNT: HuntConfig = {
  vehicle: {
    label: "Toyota Tacoma",
    make: "Toyota",
    model: "Tacoma",
    modelAliases: ["tacoma"],
    trimHints: /\bsr5\b|\btrd\b|\bsr\b|limited|pre[\s-]?runner|trailhunter|trail\s*edition/,
    fourWheelDriveOnlyTrims: [/\btrd\s*pro\b/, /\btrailhunter\b/],
    cabTypes: ["Double Cab", "Access Cab", "Crew Cab", "Regular Cab"],
    bedSizes: ["Short", "Long"],
  },

  criteria: {
    yearMin: 2019,
    yearMax: 2026,
    maxMileage: 75000,
    maxPrice: 42000,
    requiredDrivetrain: "4WD",
    preferredCabType: "Double Cab",
    preferredBedSize: "Short",
  },

  location: {
    zip: "00000",
    radiusMiles: 100,
    label: "Your Area",
    latitude: null,
    longitude: null,
  },

  exclude: {
    colorPatterns: [
      /\bwhite\b/,
      /\bice\s*cap\b/,
      /\bice\b/, // dealers truncate "Ice Cap" to "Ice"
      /\bblizzard\b/,
      /\bwind\s*chill\b/,
      /\balpine\s*white\b/, // NOT bare "alpine" — "Alpine Silver" is not white
    ],
  },

  notify: {
    buyerEmail: "you@example.com",
    digestFrom: "hunt@example.com",
    ingestEmail: "hunt@example.com",
    photoBaseUrl: "https://your-worker.example.workers.dev/img",
  },

  scoring: {
    priceFloor: 26000,
    trimScores: [
      [/trd\s*pro|trailhunter/i, 10, "TRD Pro / Trailhunter"],
      [/trd\s*off[\s-]?road|trd\s*or\b/i, 9, "TRD Off-Road"],
      [/trail\s*edition/i, 8, "Trail Edition"],
      [/trd\s*sport/i, 7, "TRD Sport"],
      [/limited/i, 6, "Limited"],
      [/nightshade/i, 6, "Nightshade"],
      [/sr5/i, 5, "SR5"],
      [/\bsr\b/i, 2, "SR (base trim)"],
    ],
    /**
     * Points awarded per model year, best year highest. Years absent from this
     * map score zero. Rebuild it for your own model — a redesign year is
     * usually worth more than simply "newer".
     */
    yearScores: {
      2019: 10, 2020: 12, 2021: 14, 2022: 15, 2023: 17,
      2024: 16, 2025: 15, 2026: 14,
    },
  },
};

/** One-line summary of the search, used in the LLM prompt and the UI. */
export function criteriaSentence(c: HuntConfig = HUNT): string {
  const bits = [
    `${c.criteria.yearMin}-${c.criteria.yearMax} model years`,
    `under ${c.criteria.maxMileage.toLocaleString()} miles`,
    `under $${c.criteria.maxPrice.toLocaleString()}`,
  ];
  if (c.criteria.requiredDrivetrain) bits.push(`${c.criteria.requiredDrivetrain} required`);
  const shape = [c.criteria.preferredCabType, c.criteria.preferredBedSize && `${c.criteria.preferredBedSize} Bed`]
    .filter(Boolean)
    .join(" + ");
  if (shape) bits.push(`${shape} preferred`);
  bits.push(`ZIP ${c.location.zip} within ${c.location.radiusMiles} miles`);
  return bits.join(", ");
}

export default HUNT;
