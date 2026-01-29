/*
  Warnings:

  - You are about to drop the column `chars_data` on the `document_data` table. All the data in the column will be lost.
  - You are about to drop the column `last_snapshot_at` on the `document_data` table. All the data in the column will be lost.
  - You are about to drop the column `log_metadata` on the `document_data` table. All the data in the column will be lost.
  - You are about to drop the column `snapshot_version` on the `document_data` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "document_data" DROP COLUMN "chars_data",
DROP COLUMN "last_snapshot_at",
DROP COLUMN "log_metadata",
DROP COLUMN "snapshot_version",
ADD COLUMN     "is_directory" BOOLEAN NOT NULL DEFAULT false;
