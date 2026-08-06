-- Email-ingest pipeline: extend existing listings table.

ALTER TABLE listings ADD COLUMN source TEXT;            -- 'carvana','truecar','carmax','autotempest','cars','autotrader','cargurus','dealer','manual'
ALTER TABLE listings ADD COLUMN sender_email TEXT;      -- raw From: of the alert email
ALTER TABLE listings ADD COLUMN ingested_at TEXT;       -- ISO8601 first time we saw this VIN
ALTER TABLE listings ADD COLUMN last_seen_at TEXT;      -- ISO8601 most recent alert mentioning this VIN
ALTER TABLE listings ADD COLUMN delisted_at TEXT;       -- ISO8601 set when sources stop reporting it
ALTER TABLE listings ADD COLUMN price_history TEXT;     -- JSON array [{price, at}, ...]
ALTER TABLE listings ADD COLUMN deal_score INTEGER;     -- cached score 0-100
ALTER TABLE listings ADD COLUMN deal_grade TEXT;        -- 'A'..'F'
ALTER TABLE listings ADD COLUMN alert_status TEXT DEFAULT 'pending';  -- 'pending','digested','dismissed'
ALTER TABLE listings ADD COLUMN distance_miles INTEGER; -- estimated distance from BUYER_ZIP

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_alert ON listings(alert_status, deal_grade);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);

CREATE TABLE IF NOT EXISTS raw_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  parsed_ok INTEGER DEFAULT 0,
  parse_error TEXT,
  listing_id INTEGER,                  -- FK to listings.id once parsed
  raw_body TEXT,                       -- truncated to 50k for debugging
  llm_response TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_emails_received ON raw_emails(received_at);
