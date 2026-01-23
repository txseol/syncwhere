/*
  Warnings:

  - A unique constraint covering the columns `[channel_id,dir,depth,name]` on the table `document_data` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "document_data_channel_id_name_key";

-- AlterTable
ALTER TABLE "document_data" ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dir" TEXT NOT NULL DEFAULT 'root';

-- CreateIndex
CREATE INDEX "document_data_dir_depth_idx" ON "document_data"("dir", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "document_data_channel_id_dir_depth_name_key" ON "document_data"("channel_id", "dir", "depth", "name");
