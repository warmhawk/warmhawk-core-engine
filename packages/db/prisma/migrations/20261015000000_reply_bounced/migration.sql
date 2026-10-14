-- Delivery-failure reports get their own reply label instead of AUTO_REPLY.
ALTER TYPE "ReplyClassification" ADD VALUE 'BOUNCED';

-- Bounces the reply poll already stored as replies: hand those leads back to the poll, which now
-- reads the report itself and records a real bounce (lead BOUNCED, the send logged as BOUNCED).
-- The text match only picks candidates. If one isn't a delivery-failure report, the next poll
-- stores it as a reply again and the classifier labels it as before. Leads go back to CONTACTED
-- with no next step, so no follow-up sends in between.
CREATE TEMP TABLE "_bounce_candidates" AS
SELECT r."id", r."leadId"
FROM "replies" r
JOIN "leads" l ON l."id" = r."leadId"
WHERE r."classification" IN ('AUTO_REPLY', 'UNCLASSIFIED')
  AND l."status" = 'REPLIED'
  AND r."rawContent" ~* '(address not found|rejected your message|undeliverable|delivery status notification|mail delivery (failed|subsystem)|delivery has failed|could not be delivered|wasn''t delivered|was not delivered|returned mail)';

UPDATE "leads" SET "status" = 'CONTACTED', "nextStepAt" = NULL, "nextRetryAt" = NULL
WHERE "id" IN (SELECT "leadId" FROM "_bounce_candidates")
  AND NOT EXISTS (
    SELECT 1 FROM "replies" r
    WHERE r."leadId" = "leads"."id" AND r."id" NOT IN (SELECT "id" FROM "_bounce_candidates")
  );

DELETE FROM "replies"
WHERE "id" IN (SELECT "id" FROM "_bounce_candidates")
  AND "leadId" IN (SELECT "id" FROM "leads" WHERE "status" = 'CONTACTED');

DROP TABLE "_bounce_candidates";
