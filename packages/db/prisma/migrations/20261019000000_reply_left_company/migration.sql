-- "No longer with the company" / "address no longer monitored" replies get their own label. They
-- stop a lead's follow-ups; away notices and other auto-replies no longer do.
ALTER TYPE "ReplyClassification" ADD VALUE 'LEFT_COMPANY';
