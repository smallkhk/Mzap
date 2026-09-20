-- Adds the self-service customer portal flag.
--
-- Off by default: an existing key does not gain a new login surface just
-- because this column now exists on its row.

-- AlterTable
ALTER TABLE `api_clients` ADD COLUMN `portalEnabled` BOOLEAN NOT NULL DEFAULT false;
