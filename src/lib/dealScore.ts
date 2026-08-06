/**
 * Deal scoring algorithm.
 *
 * Scores listings 0-100 against the criteria in hunt.config.ts, not against
 * whatever a listing site wants to promote.
 *
 * Weights:
 * - Price (26 pts): scaled across the priceFloor-to-maxPrice band
 * - Mileage (22 pts): how far under the mileage ceiling
 * - Year (17 pts): per the yearScores map
 * - Drivetrain (15 pts): required drivetrain; unknown is capped, not assumed
 * - Trim (10 pts): per the trimScores ladder
 * - Config (10 pts): preferred cab and bed
 *
 * Then a deduction, applied after the sum:
 * - Accidents: -15 for one, -25 for two, -35 for three or more
 *
 * A note on the trim weight, learned the hard way: without it, a base trim
 * and a top trim at the same price/miles/year score identically, which
 * flatters cheap base vehicles and pushes them to the top of the board. The
 * other five weights were scaled down from 30/25/20/15/10 to make room, so
 * the parts still sum to exactly 100.
 *
 * Keep this file in sync with email-worker/src/score.ts.
 */

import { HUNT } from '../../hunt.config';

export interface Listing {
  id: number;
  year: number;
  trim?: string;
  price: number | null;
  mileage?: number;
  drivetrain?: string | null;
  bed_size?: string;
  cab_type?: string;
  status?: string;
  dealer_name?: string;
  color?: string;
  notes?: string;
  listing_url?: string;
  features?: string;

  /**
   * Vehicle history reported against the VIN by the inventory feed. Null
   * means "not reported", which is NOT the same as clean — the UI renders
   * the difference, and an unreported truck is never penalised.
   * `accident_count` feeds the score; the rest is informational.
   * SQLite has no boolean: one_owner / personal_use / cpo are 0, 1 or null.
   */
  accident_count?: number | null;
  owner_count?: number | null;
  one_owner?: number | null;
  personal_use?: number | null;
  cpo?: number | null;
  msrp?: number | null;
  carfax_url?: string | null;
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
  grade: string;
  flags: string[];
}

// Everything here is read from hunt.config.ts. Retune it there, not here —
// and remember email-worker/src/score.ts is the second copy of this algorithm.
export const REQUIREMENTS = {
  maxBudget: HUNT.criteria.maxPrice,   // hard ceiling; taxes/fees on top
  priceFloor: HUNT.scoring.priceFloor, // realistic bottom of the market — anchors the price curve
  maxMileage: HUNT.criteria.maxMileage,
  acceptableYears: [HUNT.criteria.yearMin, HUNT.criteria.yearMax] as [number, number],
  maxDistanceMiles: HUNT.location.radiusMiles,
  preferredDrivetrain: HUNT.criteria.requiredDrivetrain ?? '',
  preferredCab: HUNT.criteria.preferredCabType ?? '',
  preferredBed: HUNT.criteria.preferredBedSize ?? ''
};

// Points per model year. On the original search 2022-2023 was the value sweet
// spot — the outgoing generation, sorted, and cheaper per dollar than the
// unproven redesign. Scaled to the 17-pt year weight.
const YEAR_SCORES: Record<number, number> = HUNT.scoring.yearScores;

/**
 * Trim desirability, 0-10. Order matters: the most specific names are checked
 * first, since "TRD Off-Road" also contains "TRD".
 */
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
    flags.push('Price not listed — call the dealer');
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
    flags.push('Mileage not reported — verify before deciding');
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
  const drivetrain = (listing.drivetrain || '').toUpperCase();
  if (!drivetrain) {
    drivetrainScore = 8;
    drivetrainUnknown = true;
    flags.push('Drivetrain not stated — confirm 4WD before driving out');
  } else if (drivetrain.includes('4WD') || drivetrain.includes('4X4') || drivetrain.includes('FOUR')) {
    drivetrainScore = 15;
  } else if (drivetrain.includes('AWD')) {
    drivetrainScore = 12;
  } else {
    drivetrainScore = 0;
    notFourWheelDrive = true;
    flags.push('NOT 4WD — fails a hard requirement');
  }

  // Trim Score (0-10 points)
  // A base SR and a TRD Off-Road are not the same truck at the same price.
  let trimScore = 0;
  const trimText = listing.trim || '';
  const trimMatch = TRIM_SCORES.find(([re]) => re.test(trimText));
  if (trimMatch) {
    trimScore = trimMatch[1];
    if (trimScore <= 2) flags.push(`${trimMatch[2]} — lowest equipment level`);
  } else {
    trimScore = 4; // unknown trim — don't reward or punish
    if (!trimText) flags.push('Trim not stated');
  }

  // Config Score (0-10 points)
  let configScore = 0;
  const cab = (listing.cab_type || '').toLowerCase();
  const bed = (listing.bed_size || '').toLowerCase();

  // Cab: Double Cab = 5, Crew = 5, Access = 2
  if (cab.includes('double') || cab.includes('crew')) {
    configScore += 5;
  } else if (cab.includes('access') || cab.includes('extended') || cab.includes('xtracab')) {
    configScore += 2;
  } else {
    configScore += 3; // Unknown
  }

  // Bed: Short = 5, Long = 3
  if (bed.includes('short') || bed.includes('5')) {
    configScore += 5;
  } else if (bed.includes('long') || bed.includes('6')) {
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
      `${accidents} accident${accidents === 1 ? '' : 's'} on record — −${accidentPenalty} points`,
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
    flags.push('Score capped at 79 — grade A requires confirmed 4WD');
  }

  // Grade based on total
  let grade: string;
  if (total >= 80) grade = 'A';
  else if (total >= 65) grade = 'B';
  else if (total >= 50) grade = 'C';
  else if (total >= 35) grade = 'D';
  else grade = 'F';

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

export function getScoreColor(score: number): string {
  if (score >= 80) return '#22c55e'; // green
  if (score >= 65) return '#84cc16'; // lime
  if (score >= 50) return '#eab308'; // yellow
  if (score >= 35) return '#f97316'; // orange
  return '#ef4444'; // red
}

export function getGradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'bg-green-500/20 text-green-400 border-green-500/50';
    case 'B': return 'bg-lime-500/20 text-lime-400 border-lime-500/50';
    case 'C': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
    case 'D': return 'bg-orange-500/20 text-orange-400 border-orange-500/50';
    default: return 'bg-red-500/20 text-red-400 border-red-500/50';
  }
}
