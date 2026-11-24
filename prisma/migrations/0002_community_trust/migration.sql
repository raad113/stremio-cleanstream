-- Community trust: skips start as "pending" until confirmed, and each
-- contributor (an anonymous salted hash) has approved/rejected counters.

-- Existing skips stay live.
ALTER TABLE "Segment" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "Segment" ADD COLUMN "contributorHash" TEXT;
CREATE INDEX "Segment_status_idx" ON "Segment"("status");
CREATE INDEX "Segment_contributorHash_idx" ON "Segment"("contributorHash");

CREATE TABLE "Contributor" (
    "hash" TEXT NOT NULL,
    "approved" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contributor_pkey" PRIMARY KEY ("hash")
);
