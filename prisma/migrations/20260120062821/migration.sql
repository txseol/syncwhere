-- CreateTable
CREATE TABLE "user_data" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "provider_id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "picture" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_login" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "login_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_login_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_data_provider_provider_id_key" ON "user_data"("provider", "provider_id");

-- CreateIndex
CREATE INDEX "user_login_user_id_idx" ON "user_login"("user_id");

-- CreateIndex
CREATE INDEX "user_login_login_at_idx" ON "user_login"("login_at");

-- AddForeignKey
ALTER TABLE "user_login" ADD CONSTRAINT "user_login_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;
