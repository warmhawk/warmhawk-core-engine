-- CreateEnum
CREATE TYPE "CampaignAiMode" AS ENUM ('PERSONALIZE', 'PROMPT');

-- CreateEnum
CREATE TYPE "AiWriteOutcome" AS ENUM ('AI_WRITTEN', 'TEMPLATE', 'AI_FALLBACK');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "aiMode" "CampaignAiMode" NOT NULL DEFAULT 'PERSONALIZE',
ADD COLUMN     "aiWritesSubject" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subject" TEXT;

-- Every campaign with a provider before this migration had the model write the whole email from
-- the prompt alone, with the first line becoming the subject. Keep them sending exactly as they
-- did. Campaigns with no provider send their template either way, so they keep the new default and
-- open in "adjust my email" if a provider is added later.
UPDATE "campaigns" SET "aiMode" = 'PROMPT', "aiWritesSubject" = true WHERE "aiProvider" IS NOT NULL;

-- AlterTable
ALTER TABLE "execution_logs" ADD COLUMN     "aiFallbackReason" TEXT,
ADD COLUMN     "aiOutcome" "AiWriteOutcome";

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "senderName" TEXT;
