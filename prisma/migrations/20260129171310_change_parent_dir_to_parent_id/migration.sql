/*
  Warnings:

  - You are about to drop the column `parent_dir` on the `document_data` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[channel_id,parent_id,name]` on the table `document_data` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "document_data_channel_id_parent_dir_depth_name_key";

-- DropIndex
DROP INDEX "document_data_parent_dir_depth_idx";

-- AlterTable
ALTER TABLE "document_data" DROP COLUMN "parent_dir",
ADD COLUMN     "parent_id" UUID;

-- CreateIndex
CREATE INDEX "document_data_parent_id_idx" ON "document_data"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_data_channel_id_parent_id_name_key" ON "document_data"("channel_id", "parent_id", "name");

-- AddForeignKey
ALTER TABLE "document_data" ADD CONSTRAINT "document_data_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "document_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;
