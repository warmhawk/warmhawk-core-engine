-- The server name this install gives in EHLO when a sending domain has no checked link domain,
-- and the result of its reverse-DNS check. Blank until MAIL_SERVER_NAME is set, so nothing changes.
ALTER TABLE "instance_settings" ADD COLUMN "serverName" TEXT;
ALTER TABLE "instance_settings" ADD COLUMN "serverNameStatus" "DnsRecordStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "instance_settings" ADD COLUMN "serverNameError" TEXT;
ALTER TABLE "instance_settings" ADD COLUMN "serverNameCheckedAt" TIMESTAMP(3);
