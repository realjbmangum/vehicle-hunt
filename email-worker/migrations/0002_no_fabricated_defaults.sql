-- Migration 0002 — stop the schema from inventing vehicle facts.
--
-- Two problems being fixed:
--
-- 1. `drivetrain TEXT DEFAULT '4WD'` (plus 'Short' bed and 'Double Cab')
--    meant any INSERT that omitted the column got a spec no listing ever
--    stated. Combined with the worker's `parsed.drivetrain || "4WD"`, that
--    is how rear-wheel-drive trucks entered the feed labelled 4WD.
--
-- 2. `price INTEGER NOT NULL` threw away every "call for price" listing.
--    Price is now nullable and scores as unknown instead of being dropped.
--
-- SQLite can't ALTER a column's NOT NULL or DEFAULT, so this rebuilds the
-- table. Run it against a database you can time-travel back (D1 keeps 30
-- days of restore points).

CREATE TABLE listings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  trim TEXT,
  price INTEGER,                 -- was NOT NULL
  mileage INTEGER,
  vin TEXT,
  color TEXT,
  drivetrain TEXT,               -- was DEFAULT '4WD'
  bed_size TEXT,                 -- was DEFAULT 'Short'
  cab_type TEXT,                 -- was DEFAULT 'Double Cab'
  dealer_name TEXT,
  dealer_location TEXT,
  contact_info TEXT,
  listing_url TEXT,
  features TEXT,
  photos TEXT,
  status TEXT DEFAULT 'watching' CHECK(status IN ('watching', 'contacted', 'scheduled', 'visited', 'pass', 'bought')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  source TEXT,
  sender_email TEXT,
  ingested_at TEXT,
  last_seen_at TEXT,
  delisted_at TEXT,
  price_history TEXT,
  deal_score INTEGER,
  deal_grade TEXT,
  alert_status TEXT DEFAULT 'pending',
  distance_miles INTEGER
);

INSERT INTO listings_new (
  id, year, trim, price, mileage, vin, color, drivetrain, bed_size, cab_type,
  dealer_name, dealer_location, contact_info, listing_url, features, photos,
  status, notes, created_at, updated_at, source, sender_email, ingested_at,
  last_seen_at, delisted_at, price_history, deal_score, deal_grade,
  alert_status, distance_miles
)
SELECT
  id, year, trim, price, mileage, vin, color, drivetrain, bed_size, cab_type,
  dealer_name, dealer_location, contact_info, listing_url, features, photos,
  status, notes, created_at, updated_at, source, sender_email, ingested_at,
  last_seen_at, delisted_at, price_history, deal_score, deal_grade,
  alert_status, distance_miles
FROM listings;

DROP TABLE listings;
ALTER TABLE listings_new RENAME TO listings;

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_alert ON listings(alert_status, deal_grade);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);
