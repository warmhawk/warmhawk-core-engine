-- CreateEnum
CREATE TYPE "OAuthClientProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateTable
CREATE TABLE "oauth_client_configs" (
    "id" TEXT NOT NULL,
    "provider" "OAuthClientProvider" NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_client_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_configs_provider_key" ON "oauth_client_configs"("provider");
