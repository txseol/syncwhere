/*
  Warnings:

  - You are about to drop the column `is_directory` on the `document_data` table. All the data in the column will be lost.
  - You are about to drop the column `permission` on the `document_data` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "document_data" DROP COLUMN "is_directory",
DROP COLUMN "permission";
