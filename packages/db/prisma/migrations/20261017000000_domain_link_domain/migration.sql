-- A link domain per sending domain: the host its unsubscribe link and EHLO name use once a check
-- has reached this install through it. Existing domains have none, so their mail is unchanged.
ALTER TABLE "domains" ADD COLUMN "linkDomain" TEXT;
ALTER TABLE "domains" ADD COLUMN "linkDomainStatus" "DnsRecordStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "domains" ADD COLUMN "linkDomainError" TEXT;
ALTER TABLE "domains" ADD COLUMN "linkDomainCheckedAt" TIMESTAMP(3);
