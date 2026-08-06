-- Tacoma Tracker D1 Schema

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Basic info
  year INTEGER NOT NULL,
  trim TEXT,
  price INTEGER NOT NULL,
  mileage INTEGER,
  -- Details
  vin TEXT,
  color TEXT,
  drivetrain TEXT DEFAULT '4WD',
  bed_size TEXT DEFAULT 'Short',
  cab_type TEXT DEFAULT 'Double Cab',
  -- Dealer/Source
  dealer_name TEXT,
  dealer_location TEXT,
  contact_info TEXT,
  listing_url TEXT,
  -- Features (JSON array)
  features TEXT,
  -- Photos (JSON array of URLs)
  photos TEXT,
  -- Tracking
  status TEXT DEFAULT 'watching' CHECK(status IN ('watching', 'contacted', 'scheduled', 'visited', 'pass', 'bought')),
  notes TEXT,
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);

-- Email-ingest pipeline columns (added by migrations/0001_ingest.sql).
-- ALTER TABLE listings ADD COLUMN source TEXT;
-- ALTER TABLE listings ADD COLUMN sender_email TEXT;
-- ALTER TABLE listings ADD COLUMN ingested_at TEXT;
-- ALTER TABLE listings ADD COLUMN last_seen_at TEXT;
-- ALTER TABLE listings ADD COLUMN delisted_at TEXT;
-- ALTER TABLE listings ADD COLUMN price_history TEXT;
-- ALTER TABLE listings ADD COLUMN deal_score INTEGER;
-- ALTER TABLE listings ADD COLUMN deal_grade TEXT;
-- ALTER TABLE listings ADD COLUMN alert_status TEXT DEFAULT 'pending';
-- ALTER TABLE listings ADD COLUMN distance_miles INTEGER;
-- CREATE UNIQUE INDEX idx_listings_vin ON listings(vin) WHERE vin IS NOT NULL;
--
-- Migration 0004 — vehicle history from the inventory feed. NULL means
-- "not reported", which is NOT the same as clean; the detail page renders
-- the difference. No boolean type in SQLite, so the flags are 0/1/NULL.
-- ALTER TABLE listings ADD COLUMN accident_count INTEGER;
-- ALTER TABLE listings ADD COLUMN owner_count INTEGER;
-- ALTER TABLE listings ADD COLUMN one_owner INTEGER;
-- ALTER TABLE listings ADD COLUMN personal_use INTEGER;
-- ALTER TABLE listings ADD COLUMN cpo INTEGER;
-- ALTER TABLE listings ADD COLUMN msrp INTEGER;
-- ALTER TABLE listings ADD COLUMN carfax_url TEXT;
