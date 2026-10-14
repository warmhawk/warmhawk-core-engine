-- Campaign send schedule. Every existing campaign gets a null "sendTimezone" (no schedule), so it
-- keeps sending at any hour exactly as before until its owner sets one.
ALTER TABLE "campaigns" ADD COLUMN     "maxNewLeadsPerDay" INTEGER,
ADD COLUMN     "sendDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "sendEndMinute" INTEGER,
ADD COLUMN     "sendStartMinute" INTEGER,
ADD COLUMN     "sendTimezone" TEXT,
ADD COLUMN     "useLeadTimezone" BOOLEAN NOT NULL DEFAULT false;
