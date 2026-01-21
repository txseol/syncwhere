-- AlterTable
ALTER TABLE "channel_data" ADD COLUMN     "visibility" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "channel_data_visibility_idx" ON "channel_data"("visibility");
