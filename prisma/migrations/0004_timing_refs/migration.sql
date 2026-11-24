-- Timing fingerprint of the copy a skip was marked on, so other copies can be lined up
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "refId" TEXT;
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;
