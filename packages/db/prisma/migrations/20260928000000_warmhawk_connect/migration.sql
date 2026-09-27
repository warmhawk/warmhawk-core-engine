-- CreateEnum
CREATE TYPE "OAuthVia" AS ENUM ('BYO', 'CONNECT');

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "oauthClientId" TEXT,
ADD COLUMN     "oauthVia" "OAuthVia" NOT NULL DEFAULT 'BYO';

-- AlterTable
ALTER TABLE "instance_settings" ADD COLUMN     "connectLicenseEncrypted" TEXT,
ADD COLUMN     "connectRelayBaseUrl" TEXT;
