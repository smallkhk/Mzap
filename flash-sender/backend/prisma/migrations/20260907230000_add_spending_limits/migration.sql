-- Adds per-client, per-asset spending caps for custodial sending.
--
-- Split from the initial migration rather than folded into it: that one is
-- already applied on existing deployments, and rewriting an applied
-- migration changes its checksum and blocks `prisma migrate deploy`.

-- CreateTable
CREATE TABLE `spending_limits` (
    `id` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `maxPerTxRaw` VARCHAR(191) NOT NULL,
    `maxPerDayRaw` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `spending_limits_assetId_idx`(`assetId`),
    UNIQUE INDEX `spending_limits_clientId_assetId_key`(`clientId`, `assetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `spending_limits` ADD CONSTRAINT `spending_limits_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `api_clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
