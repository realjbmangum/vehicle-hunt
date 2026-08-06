# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-06

First public release. Generalised from a personal tracker that ran from
February to August 2026, tracked 1,058 vehicles, and found the one that got
bought.

### Added

- **Inventory API sweep** — daily pull returning a VIN on every row, hard-capped
  at 30 pages per run and reporting when it truncates rather than stopping
  silently.
- **Email ingest** — saved-search alerts parsed into structured listings by
  Claude Haiku, with a sender allowlist so the worker can't be used as a relay.
- **VIN decoding** against NHTSA vPIC, batched one call per email. The VIN
  outranks listing text on drivetrain, cab and bed.
- **Deal scoring, 0–100 and A–F** across price, mileage, year, drivetrain, trim
  and configuration, with an accident deduction applied after the sum.
- **Cross-source twin matching** — the same vehicle on three sites collapses to
  one row.
- **Photo capture into R2**, so a delisted listing doesn't become a grey box.
- **Hard filters** for excluded colours and drivetrains, applied at ingest.
- **Bait-price detection** — an implausibly low price is flagged, not promoted.
- **Price history** on every listing.
- **`/replay`** — dry-run the current parser over stored emails, writing
  nothing, so a parser change can be measured against real mail first.
- **Daily digest email** ranking what changed overnight.
- **Astro dashboard** — briefing view, graded listings board, per-listing detail
  with hunt log, and a field manual page.
- **`hunt.config.ts`** — single configuration surface for vehicle, criteria,
  location, excluded colours and the scoring ladder.
- 83 tests covering VIN decoding, scoring, twin matching and the inventory
  mapper, against real captured payloads. No network, no mocks of our own code.

### Notes

The original build ran email-only for five months before the API sweep was
added. Measured over real mail, alert emails carried a VIN 25% of the time and
a drivetrain 30% of the time; the API carried both 100% of the time and
produced more listings in twelve days than any email source managed in three
months. If you're setting this up, start with the sweep.

[1.0.0]: https://github.com/realjbmangum/vehicle-hunt/releases/tag/v1.0.0
