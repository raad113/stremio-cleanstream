-- Start over: every skip is unconfirmed until viewers confirm it, or the
-- owner (admin page or editor key) does. Votes and earned trust are cleared,
-- since they were counted against data that is now unconfirmed.
-- Rejected skips stay rejected, and blocked contributors stay blocked.
UPDATE "Segment" SET "status" = 'pending', "upvotes" = 0, "downvotes" = 0, "verified" = false
  WHERE "status" = 'approved';
DELETE FROM "Vote";
UPDATE "Contributor" SET "approved" = 0;
ALTER TABLE "Segment" ALTER COLUMN "status" SET DEFAULT 'pending';
