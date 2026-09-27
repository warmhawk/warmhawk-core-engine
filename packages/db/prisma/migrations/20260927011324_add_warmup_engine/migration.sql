-- CreateEnum
CREATE TYPE "WarmupPlacement" AS ENUM ('PENDING', 'INBOX', 'SPAM', 'MISSING', 'UNCHECKED', 'FAILED');

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "warmupEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "warmupGraduatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "warmup_messages" (
    "id" TEXT NOT NULL,
    "senderMailboxId" TEXT NOT NULL,
    "recipientMailboxId" TEXT,
    "recipientSeedAccountId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placement" "WarmupPlacement" NOT NULL DEFAULT 'PENDING',
    "foundFolder" TEXT,
    "rescued" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "warmup_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warmup_messages_senderMailboxId_sentAt_idx" ON "warmup_messages"("senderMailboxId", "sentAt");

-- CreateIndex
CREATE INDEX "warmup_messages_placement_sentAt_idx" ON "warmup_messages"("placement", "sentAt");

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_senderMailboxId_fkey" FOREIGN KEY ("senderMailboxId") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_recipientMailboxId_fkey" FOREIGN KEY ("recipientMailboxId") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_recipientSeedAccountId_fkey" FOREIGN KEY ("recipientSeedAccountId") REFERENCES "seed_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
