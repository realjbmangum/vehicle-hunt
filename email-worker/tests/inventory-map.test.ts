import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  pick,
  toInt,
  firstPhoto,
  toParsedListing,
  feedDrivetrain,
  rowsFromResponse,
  cabFromFeed,
  bedFromFeed,
  listingUrl,
  historyFrom,
  priceLooksFake,
  msrpFrom,
} from "../src/inventory-map.ts";

/**
 * A real Auto.dev response, captured from the live API on 2026-07-25.
 * This is the contract — if Auto.dev changes shape, these tests fail rather
 * than the sweep quietly writing 500 rows of nulls.
 */
const REAL = JSON.parse(
  readFileSync(new URL("./fixtures/autodev-listing.json", import.meta.url), "utf8"),
);

/** The nested shape the docs describe for a default request. */
const NESTED = {
  vehicle: {
    vin: "3TMCZ5AN0KM279931",
    year: 2019,
    make: "Toyota",
    model: "Tacoma",
    trim: "SR5",
    exteriorColor: "Blue",
    bodyStyle: "Truck",
    style: "Double Cab Pickup",
    series: "SR5 4dr Double Cab 4WD 5.0 ft. SB",
    drivetrain: "4WD",
    doors: 4,
  },
  retailListing: {
    price: 33599,
    miles: 44350,
    city: "London",
    state: "KY",
    dealer: "Don Franklin London",
    vdp: "https://example-dealer.com/vehicle/abc123",
    primaryImage: "https://retail.photos.vin/3TMCZ5AN0KM279931-1.jpg",
  },
};

describe("the real captured response", () => {
  test("maps every field the sweep needs", () => {
    const l = toParsedListing(REAL);
    assert.equal(l.vin, "3TYJDAKNXRT007351");
    assert.equal(l.year, 2024);
    assert.equal(l.make, "Toyota");
    assert.equal(l.model, "Tacoma");
    assert.equal(l.trim, "SR");
    assert.equal(l.price, 32074);
    assert.equal(l.mileage, 10312, "retailListing.miles — NOT vehicle.mileage");
    assert.equal(l.dealer_name, "Scott Clark Toyota");
    assert.equal(l.dealer_location, "Matthews, NC");
    assert.equal(l.photo_url, "https://retail.photos.vin/3TYJDAKNXRT007351-1.jpg");
  });

  test('drops "Unspecified" colour instead of storing it', () => {
    assert.equal(REAL.vehicle.exteriorColor, "Unspecified");
    assert.equal(toParsedListing(REAL).color, null);
  });

  test('never reports bodyStyle "Truck" as a cab type', () => {
    assert.equal(REAL.vehicle.bodyStyle, "Truck");
    assert.equal(toParsedListing(REAL).cab_type, "Access Cab", "read from series/style");
  });

  test("reads the bed length out of the series string", () => {
    // "SR 2dr Xtracab 4WD 6.1 ft. SB" — 6.1ft is the long bed despite "SB".
    assert.equal(toParsedListing(REAL).bed_size, "Long");
  });

  test("refuses the opaque vdp reference as a URL", () => {
    assert.equal(REAL.retailListing.vdp, "#1017114909396276656");
    assert.equal(toParsedListing(REAL).listing_url, null, "links.ts falls back to a VIN search");
  });

  test("exposes the free history block", () => {
    const h = historyFrom(REAL);
    assert.equal(h.accidents, 0);
    assert.equal(h.oneOwner, true);
    assert.equal(h.owners, 1);
    assert.equal(h.cpo, false);
    assert.match(h.carfaxUrl ?? "", /^https:\/\/www\.carfax\.com\//);
  });
});

/** The flattened shape the docs say `?select=` returns. */
const FLAT = {
  "vin": "3TMDZ5BN3LM084457",
  "vehicle.year": "2020",
  "vehicle.make": "Toyota",
  "vehicle.model": "Tacoma",
  "vehicle.trim": "TRD Sport",
  "retailListing.miles": "71,636",
  "retailListing.price": "$33,476",
  "retailListing.city": "Huntersville",
  "retailListing.state": "NC",
};

describe("pick", () => {
  test("walks a dotted path", () => {
    assert.equal(pick(NESTED, "vehicle.vin"), "3TMCZ5AN0KM279931");
  });

  test("falls through to the next candidate path", () => {
    assert.equal(pick({ vin: "X" }, "vehicle.vin", "vin"), "X");
  });

  test("treats empty string as absent so the fallback still runs", () => {
    assert.equal(pick({ vehicle: { vin: "" }, vin: "Y" }, "vehicle.vin", "vin"), "Y");
  });

  test("returns null rather than throwing on a missing branch", () => {
    assert.equal(pick({}, "a.b.c.d"), null);
    assert.equal(pick(null, "a.b"), null);
  });

  test("reads a literal dotted key, which is how flattened responses arrive", () => {
    // "vehicle.vin" as a real key can't be walked as a path, so the flat
    // fixture relies on the whole-key lookup succeeding at the first segment.
    assert.equal(toParsedListing(FLAT).vin, "3TMDZ5BN3LM084457");
  });
});

describe("toInt", () => {
  test("passes through a number", () => {
    assert.equal(toInt(33599), 33599);
  });

  test("strips currency and separators", () => {
    assert.equal(toInt("$33,476"), 33476);
    assert.equal(toInt("71,636 mi"), 71636);
  });

  test("rejects zero, negatives and junk — 0 price means unknown, not free", () => {
    assert.equal(toInt(0), null);
    assert.equal(toInt("Call for price"), null);
    assert.equal(toInt(null), null);
    assert.equal(toInt(undefined), null);
  });
});

describe("firstPhoto", () => {
  test("takes the first URL from an array of strings", () => {
    assert.equal(
      firstPhoto({ photos: ["https://cdn.example.com/a/1.jpg", "https://cdn.example.com/a/2.jpg"] }),
      "https://cdn.example.com/a/1.jpg",
    );
  });

  test("prefers retailListing.primaryImage, the field the API actually uses", () => {
    assert.equal(
      firstPhoto({ retailListing: { primaryImage: "https://retail.photos.vin/X-1.jpg" } }),
      "https://retail.photos.vin/X-1.jpg",
    );
  });

  test("handles an array of objects", () => {
    assert.equal(
      firstPhoto({ photos: [{ url: "https://cdn.example.com/b/9.jpg" }] }),
      "https://cdn.example.com/b/9.jpg",
    );
  });

  test("handles a single string field", () => {
    assert.equal(
      firstPhoto({ primaryPhotoUrl: "https://cdn.example.com/c/1.jpg" }),
      "https://cdn.example.com/c/1.jpg",
    );
  });

  test("rejects non-http values rather than storing them", () => {
    assert.equal(firstPhoto({ photos: ["/relative/path.jpg"] }), null);
    assert.equal(firstPhoto({ photos: [] }), null);
    assert.equal(firstPhoto({}), null);
  });
});

describe("toParsedListing", () => {
  test("maps the nested shape completely", () => {
    const l = toParsedListing(NESTED);
    assert.equal(l.vin, "3TMCZ5AN0KM279931");
    assert.equal(l.year, 2019);
    assert.equal(l.make, "Toyota");
    assert.equal(l.model, "Tacoma");
    assert.equal(l.trim, "SR5");
    assert.equal(l.price, 33599);
    assert.equal(l.mileage, 44350);
    assert.equal(l.color, "Blue");
    assert.equal(l.dealer_name, "Don Franklin London");
    assert.equal(l.dealer_location, "London, KY");
    assert.equal(l.listing_url, "https://example-dealer.com/vehicle/abc123");
    assert.equal(l.photo_url, "https://retail.photos.vin/3TMCZ5AN0KM279931-1.jpg");
  });

  test("coerces the flattened shape's string numerics", () => {
    const l = toParsedListing(FLAT);
    assert.equal(l.year, 2020);
    assert.equal(l.price, 33476);
    assert.equal(l.mileage, 71636);
    assert.equal(l.dealer_location, "Huntersville, NC");
  });

  test("never carries a drivetrain through — the VIN decides that", () => {
    assert.equal(toParsedListing(NESTED).drivetrain, null);
    assert.equal(feedDrivetrain(NESTED), "4WD", "kept separately as a fallback only");
  });

  test("reads the short bed off the series measurement", () => {
    // "SR5 4dr Double Cab 4WD 5.0 ft. SB"
    assert.equal(toParsedListing(NESTED).bed_size, "Short");
    assert.equal(toParsedListing(NESTED).cab_type, "Double Cab");
  });

  test("never invents a bed size when the series doesn't state one", () => {
    assert.equal(bedFromFeed({ vehicle: { series: "SR5 4dr Double Cab 4WD" } }), null);
    assert.equal(bedFromFeed({}), null);
  });

  test("falls back to door count when style and series are silent", () => {
    assert.equal(cabFromFeed({ vehicle: { doors: 4 } }), "Double Cab");
    assert.equal(cabFromFeed({ vehicle: { doors: 2 } }), "Access Cab");
    assert.equal(cabFromFeed({ vehicle: { bodyStyle: "Truck" } }), null, '"Truck" says nothing');
  });

  test("only accepts a real URL as the listing link", () => {
    assert.equal(listingUrl({ retailListing: { vdp: "#101711490939" } }), null);
    assert.equal(
      listingUrl({ retailListing: { vdp: "https://dealer.example/v/1" } }),
      "https://dealer.example/v/1",
    );
  });

  test("degrades field-by-field on an unrecognised shape", () => {
    const l = toParsedListing({ vin: "3TYCZ5AN4NT091325", year: 2022, price: 35998 });
    assert.equal(l.vin, "3TYCZ5AN4NT091325");
    assert.equal(l.year, 2022);
    assert.equal(l.price, 35998);
    assert.equal(l.mileage, null);
    assert.equal(l.dealer_location, null);
  });

  test("survives an empty record without throwing", () => {
    const l = toParsedListing({});
    assert.equal(l.year, null);
    assert.equal(l.vin, null);
    assert.equal(l.photo_url, null);
  });

  test("builds a location from whichever half is present", () => {
    assert.equal(toParsedListing({ city: "Springfield" }).dealer_location, "Springfield");
    assert.equal(toParsedListing({ state: "NC" }).dealer_location, "NC");
  });
});

describe("rowsFromResponse", () => {
  test("unwraps the documented envelope", () => {
    assert.equal(rowsFromResponse({ data: [1, 2, 3], total: 3 }).length, 3);
  });

  test("accepts a bare array", () => {
    assert.equal(rowsFromResponse([1, 2]).length, 2);
  });

  test("tolerates the other envelope names the API might use", () => {
    assert.equal(rowsFromResponse({ records: [1] }).length, 1);
    assert.equal(rowsFromResponse({ listings: [1, 2] }).length, 2);
    assert.equal(rowsFromResponse({ results: [1, 2, 3] }).length, 3);
  });

  test("returns an empty array for an unexpected body instead of throwing", () => {
    assert.deepEqual(rowsFromResponse({ message: "nope" }), []);
    assert.deepEqual(rowsFromResponse(null), []);
  });
});

describe("priceLooksFake", () => {
  // Thresholds measured across 180 real listings within a 100-mile radius:
  // lowest genuine price-to-MSRP was 0.73, median 0.96. Bait listings: 0.42.
  test("catches the bait listing that reached Grade A/92", () => {
    assert.equal(priceLooksFake(16094, 38305), true, "ratio 0.42");
  });

  test("leaves the steepest genuine discount alone", () => {
    assert.equal(priceLooksFake(38600, 52955), false, "ratio 0.73 — real, Florence Toyota");
    assert.equal(priceLooksFake(29136, 38305), false, "ratio 0.76 — real");
  });

  test("does nothing without both numbers", () => {
    assert.equal(priceLooksFake(null, 38305), false);
    assert.equal(priceLooksFake(16094, null), false);
    assert.equal(priceLooksFake(16094, 0), false);
  });

  test("reads MSRP from the real captured record", () => {
    assert.equal(msrpFrom(REAL), 34700);
    assert.equal(msrpFrom({}), null);
  });
});

describe("historyFrom — zero and false are facts, not absences", () => {
  test("keeps 0 accidents as 0, never null", () => {
    // "0 accidents reported" and "we were never told" must not collapse
    // together — the UI has to be able to show the difference.
    const h = historyFrom({ history: { accidentCount: 0, ownerCount: 0 } });
    assert.equal(h.accidents, 0);
    assert.equal(h.owners, 0);
  });

  test("keeps false flags as false, never null", () => {
    const h = historyFrom({
      history: { oneOwner: false, personalUse: false },
      retailListing: { cpo: false },
    });
    assert.equal(h.oneOwner, false);
    assert.equal(h.personalUse, false);
    assert.equal(h.cpo, false);
  });

  test("reports null when the block is absent entirely", () => {
    const h = historyFrom({});
    assert.equal(h.accidents, null);
    assert.equal(h.oneOwner, null);
    assert.equal(h.owners, null);
    assert.equal(h.carfaxUrl, null);
    assert.equal(h.cpo, null);
  });

  test("rejects a non-http carfax value", () => {
    assert.equal(historyFrom({ retailListing: { carfaxUrl: "n/a" } }).carfaxUrl, null);
  });
});
