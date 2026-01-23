-- AlterTable
ALTER TABLE "channel_data" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "document_data" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "log_metadata" JSONB NOT NULL DEFAULT '[]',
    "snapshot_version" INTEGER NOT NULL DEFAULT 0,
    "last_snapshot_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "permission" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "document_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_data_channel_id_idx" ON "document_data"("channel_id");

-- CreateIndex
CREATE INDEX "document_data_created_by_idx" ON "document_data"("created_by");

-- CreateIndex
CREATE INDEX "document_data_status_idx" ON "document_data"("status");

-- CreateIndex
CREATE UNIQUE INDEX "document_data_channel_id_name_key" ON "document_data"("channel_id", "name");

-- CreateIndex
CREATE INDEX "channel_data_status_idx" ON "channel_data"("status");

-- CreateIndex
CREATE INDEX "channel_member_status_idx" ON "channel_member"("status");

-- AddForeignKey
ALTER TABLE "document_data" ADD CONSTRAINT "document_data_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_data" ADD CONSTRAINT "document_data_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;
