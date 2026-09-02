-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "DnsRecordStatus" AS ENUM ('PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "MailboxProvider" AS ENUM ('GOOGLE_WORKSPACE', 'MICROSOFT_365', 'SMTP_CUSTOM');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('WARMUP', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('UNTOUCHED', 'QUEUED', 'CONTACTED', 'OPENED', 'REPLIED', 'BOUNCED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'SENT', 'OPENED', 'REPLIED', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('GEMINI', 'CLAUDE');

-- CreateEnum
CREATE TYPE "ReplyClassification" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'OUT_OF_OFFICE', 'AUTO_REPLY', 'OPT_OUT', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "SeedAccountProvider" AS ENUM ('GMAIL', 'OUTLOOK', 'YAHOO', 'ZOHO');

-- CreateEnum
CREATE TYPE "SeedPlacementFolder" AS ENUM ('INBOX', 'SPAM', 'PROMOTIONS', 'UNCLASSIFIED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OPERATOR',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "twoFactorSecretEnc" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "domainName" TEXT NOT NULL,
    "redirectUrl" TEXT,
    "spfStatus" "DnsRecordStatus" NOT NULL DEFAULT 'PENDING',
    "dkimStatus" "DnsRecordStatus" NOT NULL DEFAULT 'PENDING',
    "dmarcStatus" "DnsRecordStatus" NOT NULL DEFAULT 'PENDING',
    "blocklistStatus" JSONB,
    "lastBlocklistCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "provider" "MailboxProvider" NOT NULL DEFAULT 'SMTP_CUSTOM',
    "dailyCap" INTEGER NOT NULL DEFAULT 25,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "status" "MailboxStatus" NOT NULL DEFAULT 'WARMUP',
    "domainId" TEXT NOT NULL,
    "smtpHost" TEXT,
    "smtpPort" INTEGER DEFAULT 587,
    "imapHost" TEXT,
    "imapPort" INTEGER DEFAULT 993,
    "authUsername" TEXT,
    "authPasswordEncrypted" TEXT,
    "oauthRefreshTokenEncrypted" TEXT,
    "oauthConnectedAt" TIMESTAMP(3),
    "oauthScope" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "warmupStartedAt" TIMESTAMP(3),
    "rollingBounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "autoFlaggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "aiPromptTemplate" TEXT NOT NULL,
    "template" TEXT,
    "aiProvider" "AiProvider",
    "unsubscribeUrlTemplate" TEXT,
    "bounceRateThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "pausedForBounceRate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "customFields" JSONB,
    "status" "LeadStatus" NOT NULL DEFAULT 'UNTOUCHED',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "queuedJobId" TEXT,
    "queuedSlotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_list" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "mailboxId" TEXT,
    "n8nExecutionId" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "payloadSent" JSONB,
    "responseReceived" JSONB,
    "errorMessage" TEXT,
    "listUnsubscribeHeader" TEXT,
    "listUnsubscribePostHeader" TEXT,
    "euAiDisclosureAppended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_keys" (
    "id" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replies" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "rawContent" TEXT NOT NULL,
    "classification" "ReplyClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "classifiedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instance_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "physicalMailingAddress" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_accounts" (
    "id" TEXT NOT NULL,
    "provider" "SeedAccountProvider" NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "imapConfigEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seed_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_placement_results" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "seedAccountId" TEXT NOT NULL,
    "folder" "SeedPlacementFolder" NOT NULL DEFAULT 'UNCLASSIFIED',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_placement_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "domains_domainName_key" ON "domains"("domainName");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_email_key" ON "mailboxes"("email");

-- CreateIndex
CREATE INDEX "mailboxes_domainId_idx" ON "mailboxes"("domainId");

-- CreateIndex
CREATE INDEX "mailboxes_status_idx" ON "mailboxes"("status");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_campaignId_idx" ON "leads"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "leads_campaignId_email_key" ON "leads"("campaignId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_list_email_key" ON "suppression_list"("email");

-- CreateIndex
CREATE INDEX "execution_logs_campaignId_idx" ON "execution_logs"("campaignId");

-- CreateIndex
CREATE INDEX "execution_logs_leadId_idx" ON "execution_logs"("leadId");

-- CreateIndex
CREATE INDEX "execution_logs_mailboxId_idx" ON "execution_logs"("mailboxId");

-- CreateIndex
CREATE INDEX "execution_logs_createdAt_idx" ON "execution_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_keys_provider_key" ON "ai_provider_keys"("provider");

-- CreateIndex
CREATE INDEX "replies_campaignId_idx" ON "replies"("campaignId");

-- CreateIndex
CREATE INDEX "replies_leadId_idx" ON "replies"("leadId");

-- CreateIndex
CREATE INDEX "replies_mailboxId_idx" ON "replies"("mailboxId");

-- CreateIndex
CREATE INDEX "replies_classification_idx" ON "replies"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "seed_accounts_emailAddress_key" ON "seed_accounts"("emailAddress");

-- CreateIndex
CREATE INDEX "seed_accounts_isActive_idx" ON "seed_accounts"("isActive");

-- CreateIndex
CREATE INDEX "seed_placement_results_campaignId_idx" ON "seed_placement_results"("campaignId");

-- CreateIndex
CREATE INDEX "seed_placement_results_seedAccountId_idx" ON "seed_placement_results"("seedAccountId");

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seed_placement_results" ADD CONSTRAINT "seed_placement_results_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seed_placement_results" ADD CONSTRAINT "seed_placement_results_seedAccountId_fkey" FOREIGN KEY ("seedAccountId") REFERENCES "seed_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
