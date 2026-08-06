// Copy of /src/lib/dealScore.ts — duplicated here so the Worker bundle
// is self-contained. Keep the algorithm identical to the Astro app.
//
// The six weighted components sum to 100: price, mileage, year, drivetrain,
// trim and configuration. Retune the inputs in hunt.config.ts rather than
// editing the arithmetic here, and change both copies together.

import { HUNT } from "../../hunt.config.ts";

export interface Listing {
  year: number;
  trim?: string | null;
  price?: number | null;
  mileage?: number | null;
  drivetrain?: string | null;
  bed_size?: string | null;
  cab_type?: string | null;
  /**
   * Reported accidents from the inventory feed. Null means "not reported",
   * which is NOT the same as zero — an unreported truck is never penalised.
   */
  accident_count?: number | null;
}

export interface ScoreBreakdown {
  price: number;
  mileage: number;
  year: number;
  drivetrain: number;
  trim: number;
  config: number;
  /** Points deducted for reported accidents. 0 when clean or unreported. */
  accidentPenalty: number;
  total: number;
  grade: "A" | "B" | "C" | "D" | "F";
  flags: string[];
}

// All four of these come from hunt.config.ts — see the `criteria` and
// `scoring` sections there to retune without touching this math.
const REQUIREMENTS = {
  maxBudget: HUNT.criteria.maxPrice,
  priceFloor: HUNT.scoring.priceFloor,
  maxMileage: HUNT.criteria.maxMileage,
  acceptableYears: [HUNT.criteria.yearMin, HUNT.criteria.yearMax] as [number, number],
};

const YEAR_SCORES: Record<number, number> = HUNT.scoring.yearScores;

const TRIM_SCORES: Array<[RegExp, number, string]> = HUNT.scoring.trimScores;

export function calculateDealScore(listing: Listing): ScoreBreakdown {
  const flags: string[] = [];

  // Price Score (0-26 points)
  // Scaled across the real market band so listings actually separate:
  // $42k = 13, $34k = 19.5, $26k or under = 26.
  let priceScore = 0;
  const price = listing.price ?? null;
  if (price === null || price <= 0) {
    priceScore = 13;
    flags.push("Price not listed — call the dealer");
  } else if (price <= REQUIREMENTS.maxBudget) {
    const band = REQUIREMENTS.maxBudget - REQUIREMENTS.priceFloor;
    const savings = REQUIREMENTS.maxBudget - price;
    priceScore = Math.min(26, 13 + (savings / band) * 13);
  } else {
    const overBy = price - REQUIREMENTS.maxBudget;
    flags.push(`Over budget by $${overBy.toLocaleString()}`);
    // Small penalty for slightly over, bigger for way over
    priceScore = Math.max(0, 9 - (overBy / 1000) * 2);
  }

  // Mileage Score (0-22 points)
  // Under 75k = acceptable, lower = better
  // null mileage = unknown, scored conservatively rather than assumed 0
  let mileageScore = 0;
  const mileage = listing.mileage ?? null;
  if (mileage === null) {
    mileageScore = 11;
    flags.push("Mileage not reported — verify before deciding");
  } else if (mileage <= REQUIREMENTS.maxMileage) {
    // 0 miles = 22 pts, 75k miles = 9 pts (base for being in range)
    mileageScore = 9 + ((REQUIREMENTS.maxMileage - mileage) / REQUIREMENTS.maxMileage) * 13;
  } else {
    const overBy = mileage - REQUIREMENTS.maxMileage;
    flags.push(`${overBy.toLocaleString()} miles over ceiling`);
    // Penalize but give some points if not too far over
    mileageScore = Math.max(0, 7 - (overBy / 10000) * 3.5);
  }

  // Year Score (0-17 points)
  let yearScore = 0;
  const [oldestOk, newestOk] = REQUIREMENTS.acceptableYears;
  if (YEAR_SCORES[listing.year] !== undefined) {
    yearScore = YEAR_SCORES[listing.year];
    if (listing.year <= 2020) flags.push(`${listing.year} model (older generation)`);
  } else if (listing.year > newestOk) {
    yearScore = 14;
  } else {
    yearScore = 4;
    flags.push(`Outside year range (${listing.year}, want ${oldestOk}+)`);
  }

  // Drivetrain Score (0-15 points)
  // 4WD is a hard requirement, so unknown is never assumed — it's scored low,
  // flagged, and caps the grade below A until confirmed.
  let drivetrainScore = 0;
  let drivetrainUnknown = false;
  let notFourWheelDrive = false;
  const drivetrain = (listing.drivetrain || "").toUpperCase();
  if (!drivetrain) {
    drivetrainScore = 8;
    drivetrainUnknown = true;
    flags.push("Drivetrain not stated — confirm 4WD before driving out");
  } else if (drivetrain.includes("4WD") || drivetrain.includes("4X4") || drivetrain.includes("FOUR")) {
    drivetrainScore = 15;
  } else if (drivetrain.includes("AWD")) {
    drivetrainScore = 12;
  } else {
    drivetrainScore = 0;
    notFourWheelDrive = true;
    flags.push("NOT 4WD — fails a hard requirement");
  }

  // Trim Score (0-10 points)
  // A base SR and a TRD Off-Road are not the same truck at the same price.
  let trimScore = 0;
  const trimText = listing.trim || "";
  const trimMatch = TRIM_SCORES.find(([re]) => re.test(trimText));
  if (trimMatch) {
    trimScore = trimMatch[1];
    if (trimScore <= 2) flags.push(`${trimMatch[2]} — lowest equipment level`);
  } else {
    trimScore = 4; // unknown trim — don't reward or punish
    if (!trimText) flags.push("Trim not stated");
  }

  // Config Score (0-10 points)
  let configScore = 0;
  const cab = (listing.cab_type || "").toLowerCase();
  const bed = (listing.bed_size || "").toLowerCase();

  // Cab: Double Cab = 5, Crew = 5, Access = 2
  if (cab.includes("double") || cab.includes("crew")) {
    configScore += 5;
  } else if (cab.includes("access") || cab.includes("extended") || cab.includes("xtracab")) {
    configScore += 2;
  } else {
    configScore += 3; // Unknown
  }

  // Bed: Short = 5, Long = 3
  if (bed.includes("short") || bed.includes("5")) {
    configScore += 5;
  } else if (bed.includes("long") || bed.includes("6")) {
    configScore += 3;
  } else {
    configScore += 3; // Unknown, assume okay
  }

  // Accident penalty — a deduction, not a category.
  //
  // Deliberately applied after the sum rather than as a seventh weight: the
  // six categories are things a truck earns, and a clean record isn't an
  // achievement, it's the baseline. Making it a category would also mean
  // re-balancing all six again, and they sum to exactly 100 on purpose.
  //
  // -15 for a single accident is the same weight as the entire drivetrain
  // category, i.e. an accident costs as much as the 4WD requirement itself.
  // That is roughly a full grade: the current watchlist tops out at 92, and
  // 92 - 15 = 77 = B.
  //
  // Note it is a deduction, NOT a cap — a truck scoring 95+ on everything
  // else would still reach A with one accident on record. Nothing in the
  // current watchlist comes close, but that is the deliberate behaviour:
  // an exceptional truck is not disqualified, only marked down.
  //
  // A truck with NO reported history is not penalised. We can't dock points
  // for something nobody told us — but the listing page says so in caution
  // colour rather than letting silence read as clean.
  const accidents = listing.accident_count ?? null;
  let accidentPenalty = 0;
  if (accidents !== null && accidents > 0) {
    accidentPenalty = accidents >= 3 ? 35 : accidents === 2 ? 25 : 15;
    flags.push(
      `${accidents} accident${accidents === 1 ? "" : "s"} on record — −${accidentPenalty} points`,
    );
  }

  let total = Math.max(
    0,
    Math.round(
      priceScore + mileageScore + yearScore + drivetrainScore + trimScore + configScore,
    ) - accidentPenalty,
  );

  if (notFourWheelDrive && total > 34) {
    // 4WD is a hard requirement, not a preference. A 2WD truck belongs in
    // the Skipped bin no matter how cheap or low-mileage it is.
    total = 34;
  } else if (drivetrainUnknown && total > 79) {
    // An unverified truck can't be a "drop everything and drive" A. Cap it
    // at the top of B until the drivetrain is confirmed.
    total = 79;
    flags.push("Score capped at 79 — grade A requires confirmed 4WD");
  }

  // Grade based on total
  let grade: ScoreBreakdown["grade"];
  if (total >= 80) grade = "A";
  else if (total >= 65) grade = "B";
  else if (total >= 50) grade = "C";
  else if (total >= 35) grade = "D";
  else grade = "F";

  return {
    price: Math.round(priceScore),
    mileage: Math.round(mileageScore),
    year: Math.round(yearScore),
    drivetrain: Math.round(drivetrainScore),
    trim: Math.round(trimScore),
    config: Math.round(configScore),
    accidentPenalty,
    total,
    grade,
    flags
  };
}
