// Hard buyer filters applied at ingest, before anything reaches D1.
//
// These are deal-breakers, not preferences — a preference belongs in the
// scoring math (score.ts), where a truck can still surface with a lower
// grade. Anything rejected here never enters the database at all.

import type { ParsedListing } from "./llm";
import { HUNT } from "../../hunt.config.ts";

export type Drivetrain = "4WD" | "2WD" | "AWD";

/**
 * Colours ruled out entirely, from `exclude.colorPatterns` in hunt.config.ts.
 *
 * These are marketing names, not colours — dealers rarely write the plain
 * word. Toyota writes "Super White", "Blizzard Pearl", "Wind Chill Pearl",
 * "Ice Cap". Matched against the exterior colour only, after stripping any
 * interior half of a two-tone string like "Ice Cap / Cement Interior".
 */
const EXCLUDED_COLOR_PATTERNS = HUNT.exclude.colorPatterns;

/** Strip the interior half of "Ice Cap / Cement Interior" and drop finish words. */
function exteriorColor(color: string): string {
  return color
    .toLowerCase()
    .split(/[/|]|\bwith\b|\bw\/\b/)[0]
    .replace(/\b(metallic|pearl|mica|premium|exterior|paint)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the listed exterior colour is one of the excluded ones.
 * Unknown colour returns false — we can't reject what we can't see.
 */
export function isExcludedColor(color: string | null | undefined): boolean {
  if (!color) return false;
  const ext = exteriorColor(color);
  if (!ext) return false;
  return EXCLUDED_COLOR_PATTERNS.some((p) => p.test(ext));
}

/** Trims that were never sold in two-wheel drive — safe to infer 4WD. */
const FOURWD_ONLY_TRIMS = HUNT.vehicle.fourWheelDriveOnlyTrims;

const FOURWD_TOKENS = /\b4x4\b|\b4wd\b|\bfour[\s-]?wheel\b|\bawd\s*\/?\s*4wd\b/;
const TWOWD_TOKENS = /\b4x2\b|\b2wd\b|\brwd\b|\bfwd\b|\brear[\s-]?wheel\b|\bfront[\s-]?wheel\b|\bpre[\s-]?runner\b/;

/**
 * Resolve drivetrain from the parsed field first, then from any 4x4/PreRunner
 * token in the trim string, then from 4WD-only trims.
 *
 * Returns null when the email genuinely doesn't say. That null is the whole
 * point: the old code defaulted unknown to "4WD" and wrote a fact into D1
 * that no email ever stated, which is how RWD trucks ended up in the feed
 * wearing a 4WD badge.
 */
export function resolveDrivetrain(parsed: {
  drivetrain?: string | null;
  trim?: string | null;
  model?: string | null;
}): Drivetrain | null {
  const explicit = (parsed.drivetrain || "").toLowerCase();
  if (explicit) {
    if (/awd|all[\s-]?wheel/.test(explicit)) return "AWD";
    if (TWOWD_TOKENS.test(explicit)) return "2WD";
    if (FOURWD_TOKENS.test(explicit) || /^4\b/.test(explicit)) return "4WD";
  }

  const text = `${parsed.trim || ""} ${parsed.model || ""}`.toLowerCase();
  if (text.trim()) {
    if (TWOWD_TOKENS.test(text)) return "2WD";
    if (FOURWD_TOKENS.test(text)) return "4WD";
    if (FOURWD_ONLY_TRIMS.some((p) => p.test(text))) return "4WD";
  }

  return null;
}

export interface RejectReason {
  rejected: boolean;
  reason?: "color" | "2wd";
}

/**
 * Hard reject gate. Unknown drivetrain is deliberately NOT rejected —
 * it's kept, stored as null, and capped in scoring so it can't reach
 * Grade A until a human confirms it by hand.
 */
export function checkHardFilters(
  parsed: ParsedListing,
  drivetrain: Drivetrain | null,
): RejectReason {
  if (isExcludedColor(parsed.color)) return { rejected: true, reason: "color" };
  if (HUNT.criteria.requiredDrivetrain === "4WD" && drivetrain === "2WD") {
    return { rejected: true, reason: "2wd" };
  }
  return { rejected: false };
}

/**
 * Is this the vehicle we're hunting? Deliberately generous — alert emails from
 * a model-scoped saved search routinely omit make and model entirely, and a
 * strict check silently drops those.
 *
 * Reads `vehicle` from hunt.config.ts, so pointing this at a different truck
 * is a config change, not a code change.
 */
export function isTargetVehicle(p: ParsedListing): boolean {
  const make = (p.make || "").toLowerCase();
  const model = (p.model || "").toLowerCase();
  const trim = (p.trim || "").toLowerCase();
  const url = (p.listing_url || "").toLowerCase();
  const aliases = HUNT.vehicle.modelAliases;

  // Explicit — the easy case.
  if (aliases.some((a) => model.includes(a))) return true;
  if (aliases.some((a) => trim.includes(a))) return true;

  // A stated model that isn't ours is someone else's vehicle — a Ranger, a
  // Colorado, or a Tundra wearing the same SR5 badge. Reject before the trim
  // heuristics below get a chance to be clever.
  if (model) return false;

  // Different make with no model at all — not ours either.
  if (make && !make.includes(HUNT.vehicle.make.toLowerCase())) return false;

  // The URL usually carries the model even when the body text doesn't.
  if (aliases.some((a) => url.includes(a))) return true;

  // No model stated — the common case for a model-scoped saved search.
  // Fall back to a trim name distinctive to this model.
  return HUNT.vehicle.trimHints.test(trim);
}
