-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "connectionError" TEXT,
ADD COLUMN     "connectionErrorAt" TIMESTAMP(3);
