/*
  Warnings:

  - A unique constraint covering the columns `[channel_id,parent_dir,depth,name]` on the table `document_data` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "document_data_channel_id_dir_depth_name_key";

-- DropIndex
DROP INDEX "document_data_dir_depth_idx";

-- AlterTable
ALTER TABLE "document_data" ADD COLUMN     "parent_dir" TEXT;

-- CreateIndex
CREATE INDEX "document_data_parent_dir_depth_idx" ON "document_data"("parent_dir", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "document_data_channel_id_parent_dir_depth_name_key" ON "document_data"("channel_id", "parent_dir", "depth", "name");
