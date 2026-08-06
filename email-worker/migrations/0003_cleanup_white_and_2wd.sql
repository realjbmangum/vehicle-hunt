-- Migration 0003 — retire the rows the new hard filters would have rejected.
--
-- Rows are marked status='pass' rather than deleted: VIN dedupe and price
-- history stay intact, and a mistake here is one UPDATE away from reversible.
--
-- Run AFTER 0002.

-- 1. White trucks. Toyota rarely writes "white" — it writes Super White,
--    Blizzard Pearl, Wind Chill Pearl, or Ice Cap. Matches the exterior
--    color only; "Cement"/"Silver"/"Celestial Silver" are untouched.
UPDATE listings
SET status = 'pass',
    alert_status = 'dismissed',
    notes = TRIM(COALESCE(notes || char(10), '') || 'Auto-passed: white exterior.'),
    updated_at = datetime('now')
WHERE status NOT IN ('pass', 'bought')
  AND color IS NOT NULL
  AND (
    lower(color) LIKE '%white%'
    OR lower(color) LIKE '%ice cap%'
    OR lower(color) LIKE 'ice%'
    OR lower(color) LIKE '%blizzard%'
    OR lower(color) LIKE '%wind chill%'
    OR lower(color) LIKE '%alpine%'
  );

-- 2. Trucks explicitly recorded as 2WD/RWD.
UPDATE listings
SET status = 'pass',
    alert_status = 'dismissed',
    notes = TRIM(COALESCE(notes || char(10), '') || 'Auto-passed: not 4WD.'),
    updated_at = datetime('now')
WHERE status NOT IN ('pass', 'bought')
  AND drivetrain IS NOT NULL
  AND (
    upper(drivetrain) LIKE '%2WD%'
    OR upper(drivetrain) LIKE '%RWD%'
    OR upper(drivetrain) LIKE '%4X2%'
    OR upper(drivetrain) LIKE '%FWD%'
    OR upper(drivetrain) LIKE '%REAR%'
    OR upper(drivetrain) LIKE '%FRONT%'
  );

-- 3. Un-fabricate the drivetrain on email-ingested rows.
--    Every one of these says '4WD' because the old code defaulted it, not
--    because any email said so. Keep it only where the trim string proves
--    4x4 (or the trim was never sold in 2WD); otherwise NULL, which now
--    renders as UNK and caps the grade below A until confirmed.
--    Manually-added rows (sender_email IS NULL) are the operator's own verified
--    entries and are left alone.
UPDATE listings
SET drivetrain = NULL,
    updated_at = datetime('now')
WHERE sender_email IS NOT NULL
  AND drivetrain IS NOT NULL
  AND upper(drivetrain) LIKE '%4WD%'
  AND NOT (
    upper(COALESCE(trim, '')) LIKE '%4X4%'
    OR upper(COALESCE(trim, '')) LIKE '%4WD%'
    OR upper(COALESCE(trim, '')) LIKE '%TRD PRO%'
    OR upper(COALESCE(trim, '')) LIKE '%TRAILHUNTER%'
  );
