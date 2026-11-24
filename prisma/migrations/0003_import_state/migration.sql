-- Remembers progress of automatic imports (for example which VideoSkip
-- files have already been imported), so daily runs only fetch new ones.
CREATE TABLE "ImportState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportState_pkey" PRIMARY KEY ("key")
);
