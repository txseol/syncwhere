-- CreateTable
CREATE TABLE "channel_data" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channel_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_member" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission" INTEGER NOT NULL DEFAULT 1,
    "status" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "join_order" INTEGER NOT NULL,

    CONSTRAINT "channel_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_data_name_key" ON "channel_data"("name");

-- CreateIndex
CREATE INDEX "channel_data_created_by_idx" ON "channel_data"("created_by");

-- CreateIndex
CREATE INDEX "channel_member_channel_id_idx" ON "channel_member"("channel_id");

-- CreateIndex
CREATE INDEX "channel_member_user_id_idx" ON "channel_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_member_channel_id_user_id_key" ON "channel_member"("channel_id", "user_id");

-- AddForeignKey
ALTER TABLE "channel_data" ADD CONSTRAINT "channel_data_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;
