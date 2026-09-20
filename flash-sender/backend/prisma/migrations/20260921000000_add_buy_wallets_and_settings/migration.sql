-- Adds per-client buy-wallet derivation and the buy-feature settings row.

-- AlterTable
ALTER TABLE `api_clients`
  ADD COLUMN `buyWalletIndex` INTEGER NULL,
  ADD COLUMN `buyWalletAddress` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `api_clients_buyWalletIndex_key` ON `api_clients`(`buyWalletIndex`);

-- CreateIndex
CREATE UNIQUE INDEX `api_clients_buyWalletAddress_key` ON `api_clients`(`buyWalletAddress`);

-- CreateTable
CREATE TABLE `app_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `buyMarkupBps` INTEGER NOT NULL DEFAULT 0,
    `profitAddress` VARCHAR(191) NULL,
    `nextBuyWalletIndex` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
