// Authoritative vehicle facts from the VIN.
//
// An alert email states the drivetrain only when the dealer bothered to type
// it. The VIN always knows — it's stamped by the manufacturer. Where we have
// one, it beats anything the email or the LLM can tell us, so it wins.
//
// Two sources, in this order:
//   1. The VDS itself (VIN position 4), which encodes cab + bed + drivetrain
//      as a single character. Free, offline, and exact.
//   2. NHTSA's vPIC decoder, for drivetrain confirmation and for model years
//      the position-4 table doesn't cover. No API key, 50 VINs per call, so a
//      whole email costs exactly one subrequest.

const VPIC_BATCH = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/";

/** AutoTempest buries the VIN in its results URL: ...&highlight=cgu-<VIN> */
const HIGHLIGHT_VIN = /highlight=[a-z]+-([A-HJ-NPR-Z0-9]{17})/i;

/** Valid VINs exclude I, O and Q to avoid confusion with 1 and 0. */
const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/i;

/**
 * Tacoma VIN signature: WMI (Toyota Mexico 3TM/3TY, Toyota Texas 5TF) plus
 * the Tacoma-specific shape of the VDS.
 *
 * The WMI alone is NOT enough — Toyota Texas stamps 5TF on Tundras and
 * Sequoias too, and a Tundra's position-4 character would otherwise be read
 * off the Tacoma table and produce a confident wrong cab. Positions 6 and 8
 * are what separate them: this matches all 237 Tacoma VINs in D1 and rejects
 * 5TFDY5F1… (Tundra) and 5TDBY5G1… (Sequoia).
 */
const TACOMA_VIN = /^(3TM|3TY|5TF)[A-Z][A-Z]5[A-Z]N/i;

export type CabType = "Double Cab" | "Access Cab" | "Regular Cab";
export type BedSize = "Short" | "Long";

/**
 * VIN position 4 — the config character — for 3rd-generation Tacomas
 * (2016-2023). One letter fixes cab, bed and drivetrain together.
 *
 * Derived by cross-tabulating all 237 VINs in D1 against vPIC. Two entries
 * have independent ground truth from real trucks in progress.txt:
 *   C — 3TMCZ5AN0KM279931, listed as "4WD Double Cab, ~5ft composite bed"
 *   D — 3TMDZ5BN3LM084457, listed as "4x4 Double Cab, 6-ft (long) bed"
 * The rest are corroborated by vPIC's `Series2` field, which independently
 * reports "Double Cab" for A/C/D/G and "Extra Cab" for R.
 *
 * 3rd-gen Access Cabs were only ever sold with the 6-foot bed, which is why
 * R and S both carry "Long".
 */
const GEN3_CONFIG: Record<
  string,
  { cab: CabType; bed: BedSize; drivetrain: "4WD" | "2WD" }
> = {
  A: { cab: "Double Cab", bed: "Short", drivetrain: "2WD" },
  B: { cab: "Double Cab", bed: "Long", drivetrain: "2WD" },
  C: { cab: "Double Cab", bed: "Short", drivetrain: "4WD" },
  D: { cab: "Double Cab", bed: "Long", drivetrain: "4WD" },
  G: { cab: "Double Cab", bed: "Short", drivetrain: "4WD" },
  R: { cab: "Access Cab", bed: "Long", drivetrain: "2WD" },
  S: { cab: "Access Cab", bed: "Long", drivetrain: "4WD" },
};

/** 4th-gen (2024+) reuses these letters for other configurations. */
const GEN3_LAST_YEAR = 2023;

export interface VinFacts {
  vin: string;
  model: string | null;
  year: number | null;
  trim: string | null;
  drivetrain: "4WD" | "2WD" | "AWD" | null;
  cabType: CabType | null;
  bedSize: BedSize | null;
}

export function isValidVin(vin: string | null | undefined): boolean {
  return !!vin && VIN_SHAPE.test(vin);
}

/** Pull a VIN out of a listing URL when the email didn't give us one. */
export function vinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(HIGHLIGHT_VIN);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Model year from VIN position 10.
 *
 * The letter cycle repeats every 30 years, so this is scoped to 2010-2030 —
 * the only window a Tacoma we'd buy can fall in. Lets the config decode work
 * even when vPIC is unreachable or silently drops the VIN from its response.
 */
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY"; // 2010 -> 2030, skipping I O Q U Z
export function yearFromVin(vin: string | null | undefined): number | null {
  if (!isValidVin(vin)) return null;
  const idx = YEAR_CODES.indexOf(vin![9].toUpperCase());
  return idx < 0 ? null : 2010 + idx;
}

/**
 * Read cab, bed and drivetrain straight out of the VIN.
 *
 * Returns nulls rather than guesses for anything outside the 3rd generation —
 * a 2024+ Tacoma uses the same letters for different configurations, so
 * applying this table to one would produce a confident wrong answer.
 */
export function configFromVin(
  vin: string | null | undefined,
  modelYear: number | null | undefined,
): { cab: CabType | null; bed: BedSize | null; drivetrain: "4WD" | "2WD" | null } {
  const empty = { cab: null, bed: null, drivetrain: null };
  if (!isValidVin(vin) || !TACOMA_VIN.test(vin!)) return empty;
  if (!modelYear || modelYear > GEN3_LAST_YEAR) return empty;

  const entry = GEN3_CONFIG[vin![3].toUpperCase()];
  return entry ? { ...entry } : empty;
}

function normalizeDrive(raw: string | null | undefined): VinFacts["drivetrain"] {
  const s = (raw || "").toLowerCase();
  if (!s) return null;
  if (s.includes("4wd") || s.includes("4x4") || s.includes("4-wheel")) return "4WD";
  if (s.includes("awd") || s.includes("all-wheel")) return "AWD";
  if (s.includes("4x2") || s.includes("rwd") || s.includes("rear")) return "2WD";
  return null;
}

/**
 * Cab type from vPIC — used only when the VIN's own config character doesn't
 * cover the model year.
 *
 * `BodyCabType` is deliberately NOT consulted. For every Tacoma vPIC returns
 * the single string "Extra/Super/Quad/Double/King/Extended", which names both
 * cab styles at once; reading it as an Access Cab is what labelled every
 * decoded truck in D1 an Access Cab. `Series2` is the field that actually
 * distinguishes them, and it is simply absent when vPIC doesn't know.
 */
function cabFromSeries2(series2: string | null | undefined): CabType | null {
  const s = (series2 || "").toLowerCase();
  if (!s) return null;
  if (s.includes("double") || s.includes("crew")) return "Double Cab";
  if (s.includes("extra") || s.includes("access") || s.includes("extended")) {
    return "Access Cab";
  }
  if (s.includes("regular") || s.includes("standard")) return "Regular Cab";
  return null;
}

/**
 * Decode up to 50 VINs in a single call. Returns a map keyed by uppercase VIN.
 * Never throws — a decoder outage must not cost us the whole email, so a
 * failure just means we fall back to the VIN's own config character and then
 * to whatever the email told us.
 */
export async function decodeVins(vins: string[]): Promise<Map<string, VinFacts>> {
  const out = new Map<string, VinFacts>();
  const unique = [...new Set(vins.filter(isValidVin).map((v) => v.toUpperCase()))];
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const res = await fetch(VPIC_BATCH, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: batch.join(";"), format: "json" }),
      });
      if (!res.ok) {
        console.error(`[vin] vPIC ${res.status} for ${batch.length} VINs`);
        continue;
      }
      const json = (await res.json()) as { Results?: any[] };
      for (const r of json.Results || []) {
        const vin = String(r.VIN || "").toUpperCase();
        if (!vin) continue;
        out.set(vin, buildFacts(vin, r));
      }
    } catch (err) {
      console.error("[vin] decode failed", err);
    }
  }

  // vPIC can silently omit a VIN from its response. Those still get the facts
  // their VDS carries rather than nothing at all.
  for (const vin of unique) {
    if (!out.has(vin)) out.set(vin, buildFacts(vin, {}));
  }
  return out;
}

/** Combine one vPIC row with what the VIN itself encodes. VIN wins on config. */
export function buildFacts(vin: string, r: Record<string, any>): VinFacts {
  const year = r.ModelYear ? Number(r.ModelYear) : yearFromVin(vin);
  const config = configFromVin(vin, year);
  const vpicDrive = normalizeDrive(r.DriveType);

  // The two should never disagree. If they do, vPIC's live database outranks
  // our static table and we want to hear about it.
  if (config.drivetrain && vpicDrive && config.drivetrain !== vpicDrive) {
    console.warn(
      `[vin] ${vin} drivetrain mismatch: VDS=${config.drivetrain} vPIC=${vpicDrive} — using vPIC`,
    );
  }

  return {
    vin,
    model: r.Model || null,
    year,
    trim: (r.Trim || r.Series2 || "").trim() || null,
    drivetrain: vpicDrive ?? config.drivetrain,
    cabType: config.cab ?? cabFromSeries2(r.Series2),
    bedSize: config.bed,
  };
}
