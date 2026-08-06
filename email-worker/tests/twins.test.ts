import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findTwin } from "../src/twins.ts";
import type { ParsedListing } from "../src/llm.ts";

/** Minimal D1 stand-in that records the bind values and returns fixed rows. */
function fakeDb(rows: any[]) {
  const calls: any[][] = [];
  return {
    calls,
    prepare(_sql: string) {
      return {
        bind(...args: any[]) {
          calls.push(args);
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  } as any;
}

function listing(over: Partial<ParsedListing> = {}): ParsedListing {
  return {
    year: 2022,
    make: "Toyota",
    model: "Tacoma",
    trim: "SR5",
    price: 33998,
    mileage: 35217,
    vin: null,
    drivetrain: null,
    cab_type: null,
    bed_size: null,
    color: "Blue",
    dealer_name: null,
    dealer_location: "Hickory, NC",
    listing_url: "https://www.cars.com/vehicledetail/89a5dad5/",
    photo_url: null,
    ...over,
  };
}

describe("findTwin", () => {
  test("matches on year + price + mileage", async () => {
    const db = fakeDb([{ id: 588, vin: null, source: "cars", status: "watching" }]);
    const res = await findTwin(db, listing({ vin: "3TMCZ5AN0KM279931" }));
    assert.equal(res.row?.id, 588);
    assert.deepEqual(db.calls[0].slice(0, 3), [2022, 33998, 35217]);
  });

  test("refuses without a mileage — year+price alone collides in real data", async () => {
    const db = fakeDb([{ id: 588, vin: null, source: "cars", status: "watching" }]);
    const res = await findTwin(db, listing({ mileage: null }));
    assert.equal(res.row, null);
    assert.equal(res.miss, "no-key");
    assert.equal(db.calls.length, 0, "must not even query");
  });

  test("refuses without a price", async () => {
    const db = fakeDb([{ id: 588, vin: null, source: "cars", status: "watching" }]);
    assert.equal((await findTwin(db, listing({ price: null }))).miss, "no-key");
  });

  test("refuses without a year", async () => {
    const db = fakeDb([{ id: 588, vin: null, source: "cars", status: "watching" }]);
    assert.equal((await findTwin(db, listing({ year: null }))).miss, "no-key");
  });

  test("reports a clean miss when nothing matches", async () => {
    const res = await findTwin(fakeDb([]), listing());
    assert.equal(res.row, null);
    assert.equal(res.miss, "none");
  });

  test("refuses to pick when two open rows share the key", async () => {
    const db = fakeDb([
      { id: 588, vin: null, source: "cars", status: "watching" },
      { id: 590, vin: null, source: "cargurus", status: "watching" },
    ]);
    const res = await findTwin(db, listing());
    assert.equal(res.row, null);
    assert.equal(res.miss, "ambiguous");
  });

  test("passes the incoming VIN so rows with a different VIN are excluded", async () => {
    const db = fakeDb([]);
    await findTwin(db, listing({ vin: "3tmcz5an0km279931" }));
    assert.equal(db.calls[0][3], "3TMCZ5AN0KM279931", "uppercased for comparison");
  });

  test("passes null when the incoming listing has no VIN", async () => {
    const db = fakeDb([]);
    await findTwin(db, listing());
    assert.equal(db.calls[0][3], null);
  });
});
