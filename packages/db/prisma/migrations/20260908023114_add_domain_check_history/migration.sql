-- CreateTable
CREATE TABLE "domain_check_history" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "spfStatus" "DnsRecordStatus" NOT NULL,
    "dkimStatus" "DnsRecordStatus" NOT NULL,
    "dmarcStatus" "DnsRecordStatus" NOT NULL,
    "blocklistStatus" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_check_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_check_history_domainId_checkedAt_idx" ON "domain_check_history"("domainId", "checkedAt");

-- AddForeignKey
ALTER TABLE "domain_check_history" ADD CONSTRAINT "domain_check_history_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
