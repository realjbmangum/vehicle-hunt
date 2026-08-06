-- Migration 0004 — store the vehicle-history facts the inventory feed carries.
--
-- Every Auto.dev record includes an accident count, an owner count, a
-- one-owner flag, personal-vs-fleet use, CPO status, the original MSRP, and a
-- direct Carfax link for that specific VIN. None of it survived ingest — the
-- listings table had nowhere to put it.
--
-- This is not decoration. The buying decision that stalled in July hinged on
-- exactly this question ("Extraction mentioned a Carfax 'Fair' condition
-- indicator — PULL THE FULL CARFAX BEFORE DRIVING TO KY"), and an alert email
-- has never once carried it.
--
-- All nullable and all additive, so this is a plain ALTER rather than the
-- table rebuild migration 0002 needed. A row with NULL here means "we were
-- never told", NOT "clean" — the UI must render the difference, the same way
-- unknown drivetrain renders UNK rather than quietly becoming 4WD.
--
-- SQLite has no boolean type; one_owner / personal_use / cpo are 0, 1 or NULL.

ALTER TABLE listings ADD COLUMN accident_count INTEGER;
ALTER TABLE listings ADD COLUMN owner_count INTEGER;
ALTER TABLE listings ADD COLUMN one_owner INTEGER;
ALTER TABLE listings ADD COLUMN personal_use INTEGER;
ALTER TABLE listings ADD COLUMN cpo INTEGER;
ALTER TABLE listings ADD COLUMN msrp INTEGER;
ALTER TABLE listings ADD COLUMN carfax_url TEXT;
