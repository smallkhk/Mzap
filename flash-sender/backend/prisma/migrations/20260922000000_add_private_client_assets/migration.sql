-- Lets an API client add a token that's private to them — never shown to
-- anyone else, including other clients and the admin dashboard's own
-- Assets list. `ownerScope` mirrors `clientId` ('global' when null) purely
-- so the uniqueness check works: MySQL doesn't treat two NULLs as equal,
-- so the old (networkId, contractAddress) unique index alone would let
-- every private asset through regardless of who added it.

-- AlterTable
ALTER TABLE `assets`
  ADD COLUMN `clientId` VARCHAR(191) NULL,
  ADD COLUMN `ownerScope` VARCHAR(191) NOT NULL DEFAULT 'global';

-- CreateIndex
-- Created before the old index is dropped: MySQL requires some index
-- covering `networkId` at all times to satisfy the existing foreign key on
-- that column, and the old unique index was the only one providing it.
CREATE UNIQUE INDEX `assets_networkId_contractAddress_ownerScope_key` ON `assets`(`networkId`, `contractAddress`, `ownerScope`);

-- DropIndex
DROP INDEX `assets_networkId_contractAddress_key` ON `assets`;

-- CreateIndex
CREATE INDEX `assets_clientId_idx` ON `assets`(`clientId`);

-- AddForeignKey
ALTER TABLE `assets`
  ADD CONSTRAINT `assets_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `api_clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
