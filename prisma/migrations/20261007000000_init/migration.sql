-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DoorbellState" AS ENUM ('NONE', 'OK', 'BROKEN');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DoorbellJobStatus" AS ENUM ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('ADMIN', 'BOT', 'OWNER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('ADMIN_LOGIN', 'ADMIN_LOGIN_FAILED', 'ADMIN_LOGOUT', 'BOT_CREATED', 'BOT_UPDATED', 'BOT_DISABLED', 'BOT_ENABLED', 'BOT_KEY_ROTATED', 'BOT_DOORBELL_CLEARED', 'BOT_DOORBELL_SET', 'BOT_DOORBELL_TESTED', 'BOT_DOORBELL_BROKEN', 'SETUP_LINK_CREATED', 'SETUP_LINK_REVOKED', 'SETUP_LINK_OPENED', 'SETUP_LINK_KEY_REVEALED', 'SETUP_LINK_COMPLETED', 'CONNECTION_APPROVED', 'CONNECTION_REACTIVATED', 'CONNECTION_REVOKED', 'MESSAGE_VIEWED', 'DOORBELL_JOB_RETRIED', 'RETENTION_PURGE');

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "nameKey" VARCHAR(60) NOT NULL,
    "ownerName" VARCHAR(80) NOT NULL,
    "ownerEmail" VARCHAR(254),
    "notes" VARCHAR(1000),
    "status" "BotStatus" NOT NULL DEFAULT 'ACTIVE',
    "apiKeyPrefix" VARCHAR(8) NOT NULL,
    "apiKeyHash" CHAR(64) NOT NULL,
    "apiKeyRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "webhookUrl" VARCHAR(500),
    "webhookKeyEnc" VARCHAR(1000),
    "doorbellState" "DoorbellState" NOT NULL DEFAULT 'NONE',
    "doorbellUpdatedAt" TIMESTAMP(3),
    "lastDoorbellError" VARCHAR(500),
    "sendLimitPerHour" INTEGER NOT NULL DEFAULT 60,
    "mcpCallLimitPerHour" INTEGER NOT NULL DEFAULT 600,
    "lastSeenAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "botAId" TEXT NOT NULL,
    "botBId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" VARCHAR(500),
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fromBotId" TEXT NOT NULL,
    "toBotId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "replyToId" TEXT,
    "subject" VARCHAR(200),
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoorbellJob" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "status" "DoorbellJobStatus" NOT NULL DEFAULT 'PENDING',
    "coalesceKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoorbellJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "botId" TEXT NOT NULL,
    "month" CHAR(7) NOT NULL,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "messagesReceived" INTEGER NOT NULL DEFAULT 0,
    "mcpCalls" INTEGER NOT NULL DEFAULT 0,
    "doorbellsSent" INTEGER NOT NULL DEFAULT 0,
    "doorbellsFailed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("botId","month")
);

-- CreateTable
CREATE TABLE "SetupLink" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "apiKeyEnc" VARCHAR(1000),
    "keyRevealedAt" TIMESTAMP(3),
    "saveAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "csrfToken" VARCHAR(64) NOT NULL,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "action" "AuditAction" NOT NULL,
    "targetType" VARCHAR(32),
    "targetId" VARCHAR(64),
    "ip" VARCHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "name" VARCHAR(64) NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastResult" JSONB,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bot_nameKey_key" ON "Bot"("nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "Bot_apiKeyPrefix_key" ON "Bot"("apiKeyPrefix");

-- CreateIndex
CREATE INDEX "Bot_status_idx" ON "Bot"("status");

-- CreateIndex
CREATE INDEX "Connection_botBId_idx" ON "Connection"("botBId");

-- CreateIndex
CREATE INDEX "Connection_status_idx" ON "Connection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_botAId_botBId_key" ON "Connection"("botAId", "botBId");

-- CreateIndex
CREATE INDEX "Message_toBotId_readAt_createdAt_idx" ON "Message"("toBotId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Message_toBotId_createdAt_idx" ON "Message"("toBotId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Message_fromBotId_createdAt_idx" ON "Message"("fromBotId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_connectionId_createdAt_idx" ON "Message"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DoorbellJob_coalesceKey_key" ON "DoorbellJob"("coalesceKey");

-- CreateIndex
CREATE INDEX "DoorbellJob_status_nextAttemptAt_idx" ON "DoorbellJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DoorbellJob_botId_createdAt_idx" ON "DoorbellJob"("botId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "UsageCounter_month_idx" ON "UsageCounter"("month");

-- CreateIndex
CREATE UNIQUE INDEX "SetupLink_tokenHash_key" ON "SetupLink"("tokenHash");

-- CreateIndex
CREATE INDEX "SetupLink_botId_createdAt_idx" ON "SetupLink"("botId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_botAId_fkey" FOREIGN KEY ("botAId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_botBId_fkey" FOREIGN KEY ("botBId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_fromBotId_fkey" FOREIGN KEY ("fromBotId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_toBotId_fkey" FOREIGN KEY ("toBotId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoorbellJob" ADD CONSTRAINT "DoorbellJob_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupLink" ADD CONSTRAINT "SetupLink_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (not managed by Prisma; see packet §6.2)
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_order_chk" CHECK ("botAId" < "botBId");
ALTER TABLE "Message" ADD CONSTRAINT "Message_distinct_chk" CHECK ("fromBotId" <> "toBotId");
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_limits_chk"
  CHECK ("sendLimitPerHour" BETWEEN 1 AND 10000 AND "mcpCallLimitPerHour" BETWEEN 1 AND 100000);
