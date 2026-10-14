-- When the user marked a reply dealt with. Existing replies start unhandled, so the ones still
-- waiting on the user (INTERESTED, UNCLASSIFIED) show in the dashboard's count until cleared.
ALTER TABLE "replies" ADD COLUMN "handledAt" TIMESTAMP(3);
