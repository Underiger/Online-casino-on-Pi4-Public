-- ═══════════════════════════════════════════════════════════════════
-- 20260612_init — Virtual Casino Sandbox 初始 migration（M02）
-- 內容：
--   1. 9 個 enum + 17 張表（03_DATABASE_DESIGN.md §1.1/§2）
--   2. 全部索引（含 BRIN ×2，由 schema @@index(type: Brin) 生成）
--   3. 外鍵（高頻寫入表一律 RESTRICT，對帳資料永不級聯消失）
--   4. raw SQL 附錄（檔尾）：物化視圖 ×3 + jackpot 單行種子（03 §3）
-- 注意：本檔為 PostgreSQL 專屬；SQLite dev 模式走
--       prisma db push --schema prisma/schema.sqlite.prisma（物化視圖跳過）
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLAYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('SLOT', 'ROULETTE');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('BET', 'PAYOUT', 'DAILY_REWARD', 'TASK_REWARD', 'GIFT_CODE', 'ADMIN_ADJUST', 'JACKPOT', 'REFUND');

-- CreateEnum
CREATE TYPE "CharmType" AS ENUM ('WEIGHT', 'RULE', 'CONDITIONAL', 'PITY', 'BONUS');

-- CreateEnum
CREATE TYPE "CharmRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('SPIN_COUNT', 'ROULETTE_ROUNDS', 'WIN_TRIPLE', 'NET_WIN', 'CHAT_COUNT');

-- CreateEnum
CREATE TYPE "LeaderboardKind" AS ENUM ('DAILY', 'WEEKLY', 'TOTAL');

-- CreateEnum
CREATE TYPE "LoginResult" AS ENUM ('SUCCESS', 'WRONG_PASSWORD', 'BANNED', 'TOTP_FAILED');

-- CreateEnum
CREATE TYPE "PacketViolation" AS ENUM ('BAD_SIGNATURE', 'NONCE_REPLAY', 'SEQ_REGRESSION', 'STALE_TIMESTAMP', 'OUT_OF_WINDOW', 'RATE_LIMIT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" VARCHAR(20) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PLAYER',
    "balance" BIGINT NOT NULL DEFAULT 5000,
    "version" INTEGER NOT NULL DEFAULT 0,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "avatar_id" INTEGER NOT NULL DEFAULT 0,
    "jackpot_points" INTEGER NOT NULL DEFAULT 0,
    "pity_counter" INTEGER NOT NULL DEFAULT 0,
    "login_streak" INTEGER NOT NULL DEFAULT 0,
    "last_daily_at" TIMESTAMP(3),
    "totp_secret_enc" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recovery_codes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "delta" BIGINT NOT NULL,
    "balance_before" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_id" TEXT,
    "memo" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_type" "GameType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL DEFAULT 0,
    "detail" JSONB NOT NULL,
    "round_id" TEXT,
    "server_seed_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charms" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "type" "CharmType" NOT NULL,
    "rarity" "CharmRarity" NOT NULL,
    "effect" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_charms" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "charm_id" TEXT NOT NULL,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "slot" INTEGER,
    "obtained_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_charms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpot" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pool" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jackpot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpot_history" (
    "id" TEXT NOT NULL,
    "jackpot_id" INTEGER NOT NULL DEFAULT 1,
    "user_id" TEXT NOT NULL,
    "pool_before" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL,
    "remained" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jackpot_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_codes" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "amount" BIGINT NOT NULL,
    "charm_id" TEXT,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_code_redemptions" (
    "id" TEXT NOT NULL,
    "gift_code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "username" VARCHAR(20) NOT NULL,
    "ip" VARCHAR(45) NOT NULL,
    "user_agent" VARCHAR(255) NOT NULL,
    "result" "LoginResult" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "content" VARCHAR(200) NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "id" TEXT NOT NULL,
    "kind" "LeaderboardKind" NOT NULL,
    "period_key" VARCHAR(10),
    "rank" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "score" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_tasks" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "type" "TaskType" NOT NULL,
    "target" INTEGER NOT NULL,
    "reward_coin" BIGINT NOT NULL DEFAULT 0,
    "reward_charm" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "daily_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_daily_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "date_key" VARCHAR(10) NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimed_at" TIMESTAMP(3),

    CONSTRAINT "user_daily_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "target_user_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(45) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "illegal_packet_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "ip" VARCHAR(45) NOT NULL,
    "violation" "PacketViolation" NOT NULL,
    "endpoint" VARCHAR(80) NOT NULL,
    "raw_sample" VARCHAR(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "illegal_packet_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(60) NOT NULL,
    "content" VARCHAR(500) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(120) NOT NULL,
    "reward_coin" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "achievement_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_flagged_idx" ON "users"("flagged");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_id_idx" ON "refresh_tokens"("user_id", "family_id");

-- CreateIndex
CREATE INDEX "balance_transactions_user_id_created_at_idx" ON "balance_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "balance_transactions_type_created_at_idx" ON "balance_transactions"("type", "created_at");

-- CreateIndex
CREATE INDEX "balance_tx_created_brin" ON "balance_transactions" USING BRIN ("created_at");

-- CreateIndex
CREATE INDEX "bet_records_user_id_created_at_idx" ON "bet_records"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "bet_records_game_type_created_at_idx" ON "bet_records"("game_type", "created_at");

-- CreateIndex
CREATE INDEX "bet_records_round_id_idx" ON "bet_records"("round_id");

-- CreateIndex
CREATE INDEX "bet_records_created_brin" ON "bet_records" USING BRIN ("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "charms_code_key" ON "charms"("code");

-- CreateIndex
CREATE INDEX "user_charms_user_id_equipped_idx" ON "user_charms"("user_id", "equipped");

-- CreateIndex
CREATE UNIQUE INDEX "user_charms_user_id_charm_id_key" ON "user_charms"("user_id", "charm_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_charms_user_id_slot_key" ON "user_charms"("user_id", "slot");

-- CreateIndex
CREATE INDEX "jackpot_history_created_at_idx" ON "jackpot_history"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gift_codes_code_key" ON "gift_codes"("code");

-- CreateIndex
CREATE INDEX "gift_codes_expires_at_idx" ON "gift_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "gift_code_redemptions_gift_code_id_user_id_key" ON "gift_code_redemptions"("gift_code_id", "user_id");

-- CreateIndex
CREATE INDEX "login_logs_user_id_created_at_idx" ON "login_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "login_logs_ip_created_at_idx" ON "login_logs"("ip", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages"("created_at");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_user_id_idx" ON "leaderboard_snapshots"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_snapshots_kind_period_key_rank_key" ON "leaderboard_snapshots"("kind", "period_key", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "daily_tasks_code_key" ON "daily_tasks"("code");

-- CreateIndex
CREATE INDEX "user_daily_progress_date_key_idx" ON "user_daily_progress"("date_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_daily_progress_user_id_task_id_date_key_key" ON "user_daily_progress"("user_id", "task_id", "date_key");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_user_id_idx" ON "admin_audit_logs"("target_user_id");

-- CreateIndex
CREATE INDEX "illegal_packet_logs_user_id_created_at_idx" ON "illegal_packet_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "illegal_packet_logs_violation_created_at_idx" ON "illegal_packet_logs"("violation", "created_at");

-- CreateIndex
CREATE INDEX "announcements_active_starts_at_idx" ON "announcements"("active", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "achievements_code_key" ON "achievements"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_user_id_achievement_id_key" ON "user_achievements"("user_id", "achievement_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_records" ADD CONSTRAINT "bet_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_charms" ADD CONSTRAINT "user_charms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_charms" ADD CONSTRAINT "user_charms_charm_id_fkey" FOREIGN KEY ("charm_id") REFERENCES "charms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jackpot_history" ADD CONSTRAINT "jackpot_history_jackpot_id_fkey" FOREIGN KEY ("jackpot_id") REFERENCES "jackpot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jackpot_history" ADD CONSTRAINT "jackpot_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_code_redemptions" ADD CONSTRAINT "gift_code_redemptions_gift_code_id_fkey" FOREIGN KEY ("gift_code_id") REFERENCES "gift_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_code_redemptions" ADD CONSTRAINT "gift_code_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_daily_progress" ADD CONSTRAINT "user_daily_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_daily_progress" ADD CONSTRAINT "user_daily_progress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "daily_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Raw SQL 附錄（03_DATABASE_DESIGN.md §3）— 不進 Prisma schema 的 PG 專屬物件
-- ═══════════════════════════════════════════════════════════════════

-- 物化視圖：今日淨贏分 Top 100（Asia/Taipei 為日界）
-- 由 BullMQ leaderboard-refresh.job 每 5 分鐘 REFRESH MATERIALIZED VIEW CONCURRENTLY
-- （CONCURRENTLY 需 unique index，故每張視圖都建 *_uid）
CREATE MATERIALIZED VIEW leaderboard_daily AS
  SELECT user_id, SUM(payout - amount) AS net_win
  FROM bet_records
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Taipei')
  GROUP BY user_id ORDER BY net_win DESC LIMIT 100;
CREATE UNIQUE INDEX leaderboard_daily_uid ON leaderboard_daily(user_id);

-- 物化視圖：本週淨贏分 Top 100（同構，週界）
CREATE MATERIALIZED VIEW leaderboard_weekly AS
  SELECT user_id, SUM(payout - amount) AS net_win
  FROM bet_records
  WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'Asia/Taipei')
  GROUP BY user_id ORDER BY net_win DESC LIMIT 100;
CREATE UNIQUE INDEX leaderboard_weekly_uid ON leaderboard_weekly(user_id);

-- 物化視圖：總資產 Top 100（直接以 users.balance 排序；排除 Admin 與封鎖帳號）
CREATE MATERIALIZED VIEW leaderboard_total AS
  SELECT id AS user_id, balance AS score
  FROM users
  WHERE role = 'PLAYER' AND banned = false
  ORDER BY balance DESC LIMIT 100;
CREATE UNIQUE INDEX leaderboard_total_uid ON leaderboard_total(user_id);

-- 種子資料：jackpot 單行（id 恆為 1；updated_at 由 Prisma @updatedAt 管理，初始給 now()）
INSERT INTO jackpot (id, pool, version, updated_at)
VALUES (1, 0, 0, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

