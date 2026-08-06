import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isValidVin,
  vinFromUrl,
  yearFromVin,
  configFromVin,
  buildFacts,
} from "../src/vin.ts";

describe("isValidVin", () => {
  test("accepts a real Tacoma VIN", () => {
    assert.equal(isValidVin("3TMCZ5AN0KM279931"), true);
  });

  test("rejects wrong length", () => {
    assert.equal(isValidVin("3TMCZ5AN0KM27993"), false);
    assert.equal(isValidVin("3TMCZ5AN0KM2799311"), false);
  });

  test("rejects I, O and Q, which VINs never use", () => {
    assert.equal(isValidVin("3TMCZ5ANOKM279931"), false);
    assert.equal(isValidVin("3TMCZ5AN0KM27993I"), false);
    assert.equal(isValidVin("3TMCZ5ANQKM279931"), false);
  });

  test("rejects null and empty", () => {
    assert.equal(isValidVin(null), false);
    assert.equal(isValidVin(""), false);
  });
});

describe("vinFromUrl", () => {
  // AutoTempest links carry the VIN of the aggregated listing, prefixed by
  // the source that supplied it: cm- = cars.com, cgu- = CarGurus.
  test("recovers a cars.com VIN from an AutoTempest link", () => {
    const url =
      "https://www.autotempest.com/results?alert_id=b163f9c4&make_model=toyota_tacoma" +
      "&zip=00000&highlight=cm-3TMAZ5CN5PM206257";
    assert.equal(vinFromUrl(url), "3TMAZ5CN5PM206257");
  });

  test("recovers a CarGurus VIN", () => {
    assert.equal(
      vinFromUrl("https://www.autotempest.com/results?highlight=cgu-3TYCZ5AN4NT091325"),
      "3TYCZ5AN4NT091325",
    );
  });

  test("returns null when the URL carries no VIN", () => {
    assert.equal(vinFromUrl("https://www.cars.com/vehicledetail/262fea4b-6012/"), null);
    assert.equal(vinFromUrl(null), null);
  });
});

describe("yearFromVin", () => {
  // Ground truth from progress.txt — two trucks with confirmed model years.
  test("decodes position 10 against known trucks", () => {
    assert.equal(yearFromVin("3TMCZ5AN0KM279931"), 2019);
    assert.equal(yearFromVin("3TMDZ5BN3LM084457"), 2020);
    assert.equal(yearFromVin("3TMBZ5DN6NM033753"), 2022);
    assert.equal(yearFromVin("3TYLB5JN2ST103357"), 2025);
  });

  test("returns null for an invalid VIN", () => {
    assert.equal(yearFromVin("nope"), null);
  });
});

describe("configFromVin", () => {
  // The two entries with independent ground truth in progress.txt.
  test("C = Double Cab, short bed, 4WD (VIN 3TMCZ5AN0KM279931)", () => {
    assert.deepEqual(configFromVin("3TMCZ5AN0KM279931", 2019), {
      cab: "Double Cab",
      bed: "Short",
      drivetrain: "4WD",
    });
  });

  test("D = Double Cab, long bed, 4WD (VIN 3TMDZ5BN3LM084457)", () => {
    assert.deepEqual(configFromVin("3TMDZ5BN3LM084457", 2020), {
      cab: "Double Cab",
      bed: "Long",
      drivetrain: "4WD",
    });
  });

  // vPIC's Series2 reports "Extra Cab" for these, confirming the mapping.
  test("R = Access Cab, long bed, 2WD", () => {
    assert.deepEqual(configFromVin("3TYRX5GN0NT062993", 2022), {
      cab: "Access Cab",
      bed: "Long",
      drivetrain: "2WD",
    });
  });

  test("S = Access Cab, long bed, 4WD", () => {
    assert.deepEqual(configFromVin("3TYSX5EN0MT007253", 2021), {
      cab: "Access Cab",
      bed: "Long",
      drivetrain: "4WD",
    });
  });

  test("A and B are the 2WD Double Cabs", () => {
    assert.equal(configFromVin("3TMAZ5CN5PM206257", 2023).drivetrain, "2WD");
    assert.equal(configFromVin("3TMAZ5CN5PM206257", 2023).bed, "Short");
    assert.equal(configFromVin("3TMBZ5DN6NM033753", 2022).drivetrain, "2WD");
    assert.equal(configFromVin("3TMBZ5DN6NM033753", 2022).bed, "Long");
  });

  test("refuses to decode 2024+ — 4th gen reuses the letters", () => {
    assert.deepEqual(configFromVin("3TYLB5JN2ST103357", 2025), {
      cab: null,
      bed: null,
      drivetrain: null,
    });
  });

  test("refuses other Toyota trucks sharing the 5TF WMI", () => {
    // Toyota Texas stamps 5TF on Tundras too, and 'D' at position 4 would
    // otherwise be read off the Tacoma table as a long-bed Double Cab.
    assert.equal(configFromVin("5TFDY5F13DX123456", 2013).cab, null, "Tundra CrewMax");
    assert.equal(configFromVin("5TFUY5F17AX123456", 2010).cab, null, "Tundra Double Cab");
    assert.equal(configFromVin("5TDBY5G17KS123456", 2019).cab, null, "Sequoia");
    // A genuine 5TF-built Tacoma still decodes.
    assert.equal(configFromVin("5TFAZ5CN0MX123456", 2021).cab, "Double Cab");
  });

  test("falls back to the VIN's own year when none is passed", () => {
    assert.equal(configFromVin("3TMCZ5AN0KM279931", yearFromVin("3TMCZ5AN0KM279931")).cab,
      "Double Cab");
  });

  test("returns nulls for an unmapped config character", () => {
    assert.deepEqual(configFromVin("3TMZZ5AN0KM279931", 2019), {
      cab: null,
      bed: null,
      drivetrain: null,
    });
  });
});

describe("buildFacts", () => {
  // The bug this replaces: vPIC returns one string naming BOTH cab styles,
  // and reading it as an Access Cab mislabelled every decoded Tacoma in D1.
  const AMBIGUOUS_CAB = "Extra/Super/Quad/Double/King/Extended";

  test("ignores vPIC's ambiguous BodyCabType in favour of the VIN", () => {
    const facts = buildFacts("3TMCZ5AN0KM279931", {
      ModelYear: "2019",
      Model: "Tacoma",
      DriveType: "4WD/4-Wheel Drive/4x4",
      BodyCabType: AMBIGUOUS_CAB,
      BodyClass: "Pickup",
    });
    assert.equal(facts.cabType, "Double Cab");
    assert.equal(facts.bedSize, "Short");
    assert.equal(facts.drivetrain, "4WD");
  });

  test("an Access Cab still decodes as one", () => {
    const facts = buildFacts("3TYSX5EN0MT007253", {
      ModelYear: "2021",
      DriveType: "4WD/4-Wheel Drive/4x4",
      BodyCabType: AMBIGUOUS_CAB,
    });
    assert.equal(facts.cabType, "Access Cab");
    assert.equal(facts.bedSize, "Long");
  });

  test("uses Series2 for model years the VIN table won't cover", () => {
    const facts = buildFacts("3TYLB5JN2ST103357", {
      ModelYear: "2025",
      Series2: "Double Cab",
      DriveType: "4WD/4-Wheel Drive/4x4",
      BodyCabType: AMBIGUOUS_CAB,
    });
    assert.equal(facts.cabType, "Double Cab");
    assert.equal(facts.bedSize, null, "bed is unknown for 4th gen — must not guess");
  });

  test("survives vPIC returning nothing for a VIN", () => {
    const facts = buildFacts("3TMCZ5AN0KM279931", {});
    assert.equal(facts.year, 2019, "year comes from the VIN itself");
    assert.equal(facts.cabType, "Double Cab");
    assert.equal(facts.drivetrain, "4WD");
  });

  test("prefers vPIC's drivetrain when it contradicts the VDS table", () => {
    const facts = buildFacts("3TMCZ5AN0KM279931", {
      ModelYear: "2019",
      DriveType: "4x2",
    });
    assert.equal(facts.drivetrain, "2WD");
  });

  test("reports AWD, which the VDS table has no code for", () => {
    const facts = buildFacts("3TMZZ5AN0KM279931", {
      ModelYear: "2019",
      DriveType: "AWD/All-Wheel Drive",
    });
    assert.equal(facts.drivetrain, "AWD");
  });
});
