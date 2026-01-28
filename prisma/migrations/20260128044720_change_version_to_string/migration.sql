-- AlterTable
ALTER TABLE "document_data" ALTER COLUMN "snapshot_version" SET DEFAULT '1.0.0',
ALTER COLUMN "snapshot_version" SET DATA TYPE VARCHAR(20);
