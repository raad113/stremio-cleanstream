-- Contributor identity follows the app (contributorHash); the connection it came
-- from is kept separately so one home cannot confirm its own marks
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "connectionHash" TEXT;
