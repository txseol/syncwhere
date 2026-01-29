/*
  Warnings:

  - A unique constraint covering the columns `[channel_id,parent_id,dir,name]` on the table `document_data` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "document_data_channel_id_parent_id_name_dir_key";

-- CreateIndex
CREATE UNIQUE INDEX "document_data_channel_id_parent_id_dir_name_key" ON "document_data"("channel_id", "parent_id", "dir", "name");
