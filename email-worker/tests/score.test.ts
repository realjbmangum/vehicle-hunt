import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateDealScore } from "../src/score.ts";

/** A strong, fully-specified truck — the control for every case below. */
function truck(over: Record<string, any> = {}) {
  return {
    year: 2022,
    trim: "TRD Off-Road",
    price: 33000,
    mileage: 35000,
    drivetrain: "4WD",
    cab_type: "Double Cab",
    bed_size: "Short",
    ...over,
  };
}

describe("accident penalty", () => {
  test("a clean record scores exactly the same as an unreported one", () => {
    // Neither is penalised. We can't dock points for something nobody told
    // us, and a reported-clean truck earns nothing extra for it either.
    const clean = calculateDealScore(truck({ accident_count: 0 }));
    const unknown = calculateDealScore(truck({ accident_count: null }));
    const absent = calculateDealScore(truck());
    assert.equal(clean.total, unknown.total);
    assert.equal(clean.total, absent.total);
    assert.equal(clean.accidentPenalty, 0);
  });

  test("one accident costs 15 — the same as the whole drivetrain category", () => {
    const base = calculateDealScore(truck()).total;
    const hit = calculateDealScore(truck({ accident_count: 1 }));
    assert.equal(hit.accidentPenalty, 15);
    assert.equal(hit.total, base - 15);
  });

  test("two cost 25, three or more cost 35", () => {
    const base = calculateDealScore(truck()).total;
    assert.equal(calculateDealScore(truck({ accident_count: 2 })).total, base - 25);
    assert.equal(calculateDealScore(truck({ accident_count: 3 })).total, base - 35);
    assert.equal(calculateDealScore(truck({ accident_count: 9 })).total, base - 35);
  });

  test("costs roughly a full grade on a realistic top-of-watchlist truck", () => {
    // The real watchlist tops out at 92; 92 - 15 = 77 = B.
    const best = calculateDealScore(truck({ price: 29000, mileage: 28000, year: 2022 }));
    assert.equal(best.grade, "A");
    const wrecked = calculateDealScore(
      truck({ price: 29000, mileage: 28000, year: 2022, accident_count: 1 }),
    );
    assert.equal(wrecked.grade, "B", `${best.total} -> ${wrecked.total}`);
  });

  test("is a deduction, not a disqualification", () => {
    // Documented deliberately: a truck exceptional on every other axis can
    // still reach A with one accident. Nothing in the current watchlist is
    // close, but the rule marks down rather than excludes.
    const perfect = calculateDealScore({
      year: 2023,
      trim: "TRD Pro",
      price: 20000,
      mileage: 0,
      drivetrain: "4WD",
      cab_type: "Double Cab",
      bed_size: "Short",
      accident_count: 1,
    });
    assert.equal(perfect.total, 85);
    assert.equal(perfect.grade, "A");
  });

  test("explains itself in the flags", () => {
    const one = calculateDealScore(truck({ accident_count: 1 }));
    assert.ok(one.flags.some((f) => /1 accident on record/.test(f)));
    const two = calculateDealScore(truck({ accident_count: 2 }));
    assert.ok(two.flags.some((f) => /2 accidents on record/.test(f)), "pluralised");
  });

  test("never drives the total below zero", () => {
    const wreck = calculateDealScore({
      year: 2019,
      trim: "SR",
      price: 41999,
      mileage: 74999,
      drivetrain: "2WD",
      accident_count: 9,
    });
    assert.ok(wreck.total >= 0);
  });

  test("a 2WD truck is still capped in the Skipped bin, penalty or not", () => {
    // The hard-requirement cap must win over the deduction, not double up.
    const s = calculateDealScore(truck({ drivetrain: "2WD", accident_count: 1 }));
    assert.ok(s.total <= 34);
  });
});

describe("the deduction sits outside the six categories", () => {
  test("category scores are untouched by an accident", () => {
    const clean = calculateDealScore(truck());
    const hit = calculateDealScore(truck({ accident_count: 2 }));
    for (const k of ["price", "mileage", "year", "drivetrain", "trim", "config"] as const) {
      assert.equal(hit[k], clean[k], `${k} must not move`);
    }
  });

  test("the six categories still sum to 100 at their maximum", () => {
    // Guards the invariant the header comment claims.
    const maxed = calculateDealScore({
      year: 2023,
      trim: "TRD Pro",
      price: 20000,
      mileage: 0,
      drivetrain: "4WD",
      cab_type: "Double Cab",
      bed_size: "Short",
    });
    assert.equal(
      maxed.price + maxed.mileage + maxed.year + maxed.drivetrain + maxed.trim + maxed.config,
      100,
    );
  });
});
