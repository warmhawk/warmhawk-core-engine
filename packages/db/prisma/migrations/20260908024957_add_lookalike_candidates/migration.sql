-- CreateTable
CREATE TABLE "lookalike_candidates" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "candidateDomain" TEXT NOT NULL,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lookalike_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lookalike_candidates_domainId_candidateDomain_key" ON "lookalike_candidates"("domainId", "candidateDomain");

-- AddForeignKey
ALTER TABLE "lookalike_candidates" ADD CONSTRAINT "lookalike_candidates_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
