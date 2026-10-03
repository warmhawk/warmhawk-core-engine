-- Per-domain CAN-SPAM mailing address, campaign sender pick, and follow-up sequences (10-03-26).

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "label" TEXT,
ADD COLUMN     "mailingAddress" TEXT,
ADD COLUMN     "mailingAddressParts" JSONB;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "lastStepAt" TIMESTAMP(3),
ADD COLUMN     "mailboxId" TEXT,
ADD COLUMN     "nextStepAt" TIMESTAMP(3),
ADD COLUMN     "stepsSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "threadSubject" TEXT;

-- CreateTable
CREATE TABLE "campaign_mailboxes" (
    "campaignId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_mailboxes_pkey" PRIMARY KEY ("campaignId","mailboxId")
);

-- CreateTable
CREATE TABLE "campaign_steps" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "waitDays" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "aiRewrite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_mailboxes_mailboxId_idx" ON "campaign_mailboxes"("mailboxId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_steps_campaignId_position_key" ON "campaign_steps"("campaignId", "position");

-- CreateIndex
CREATE INDEX "leads_nextStepAt_idx" ON "leads"("nextStepAt");

-- CreateIndex
CREATE INDEX "leads_mailboxId_idx" ON "leads"("mailboxId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_mailboxes" ADD CONSTRAINT "campaign_mailboxes_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_mailboxes" ADD CONSTRAINT "campaign_mailboxes_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: existing campaigns keep sending from what they send from today — every ACTIVE mailbox.
-- New campaigns start with none ticked; the operator picks them on the Send from step.
INSERT INTO "campaign_mailboxes" ("campaignId", "mailboxId", "createdAt")
SELECT c."id", m."id", CURRENT_TIMESTAMP
FROM "campaigns" c CROSS JOIN "mailboxes" m
WHERE m."status" = 'ACTIVE' AND c."status" <> 'ARCHIVED';

-- Backfill: pin every already-contacted lead to the mailbox of its first send, so a follow-up added
-- later goes from the same sender. Their first email counts as step 1.
UPDATE "leads" l
SET "mailboxId" = s."mailboxId", "stepsSent" = 1, "lastStepAt" = s."createdAt"
FROM (
  SELECT DISTINCT ON ("leadId") "leadId", "mailboxId", "createdAt"
  FROM "execution_logs"
  WHERE "status" = 'SENT' AND "leadId" IS NOT NULL
  ORDER BY "leadId", "createdAt" ASC
) s
WHERE l."id" = s."leadId";

-- A sent lead used to keep the BullMQ job id of its first send. Follow-ups use `queuedJobId` to mean
-- "a send is on the queue right now", so clear the stale ones.
UPDATE "leads" SET "queuedJobId" = NULL, "queuedSlotAt" = NULL WHERE "status" <> 'QUEUED';
