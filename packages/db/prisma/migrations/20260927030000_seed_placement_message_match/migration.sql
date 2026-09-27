-- AlterTable
ALTER TABLE "seed_placement_results" ADD COLUMN     "mailboxId" TEXT,
ADD COLUMN     "messageId" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "subjectSha256" TEXT,
ALTER COLUMN "checkedAt" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "seed_placement_results_mailboxId_idx" ON "seed_placement_results"("mailboxId");

-- CreateIndex
CREATE INDEX "seed_placement_results_checkedAt_idx" ON "seed_placement_results"("checkedAt");

-- AddForeignKey
ALTER TABLE "seed_placement_results" ADD CONSTRAINT "seed_placement_results_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
