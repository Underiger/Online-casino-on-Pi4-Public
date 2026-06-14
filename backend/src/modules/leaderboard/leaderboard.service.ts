/**
 * Leaderboard 服務（01_GDD §5.2、02_TDD §6.2、05_MILESTONES M19）。
 *
 * 職責：
 *   1. getLeaderboard — 查詢物化視圖（leaderboard_daily/weekly/total）+ JOIN users
 *   2. refreshViews   — REFRESH MATERIALIZED VIEW CONCURRENTLY（BullMQ 每 5 分鐘呼叫）
 *   3. snapshotDailyTop100 — 讀昨日 bet_records，寫入 LeaderboardSnapshot（00:00 呼叫）
 */
import type { PrismaClient } from '@prisma/client';
import { LeaderboardKind } from '@prisma/client';
import type { Redis } from 'ioredis';
import { ValidationError } from '../../shared/errors.js';

// ─── Response 型別（鏡像 @casino/shared dto/leaderboard.dto.ts；backend 不 import shared） ──

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarId: number;
  score: string;
}

export interface LeaderboardRes {
  kind: LeaderboardKind;
  periodKey: string | null;
  entries: LeaderboardEntry[];
  refreshedAt: string;
}

// ─── 服務型別 ──────────────────────────────────────────────────────────────────

export interface LeaderboardServiceLog {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface LeaderboardServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  log?: LeaderboardServiceLog;
}

interface ViewRow {
  user_id: string;
  score: unknown;
  username: string;
  avatar_id: unknown;
}

// ─── 常數 ─────────────────────────────────────────────────────────────────────

const REFRESHED_AT_KEY = 'leaderboard:refreshed_at';

const KIND_MAP: Record<string, LeaderboardKind> = {
  daily:  LeaderboardKind.DAILY,
  weekly: LeaderboardKind.WEEKLY,
  total:  LeaderboardKind.TOTAL,
};

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

function getTodayDateKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function getWeeklyPeriodKey(): string {
  // ISO 8601 week number: "YYYY-WNN"
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
  const today = fmt.format(new Date()); // "YYYY-MM-DD"
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // shift to nearest Thursday (ISO week anchor)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createLeaderboardService(deps: LeaderboardServiceDeps) {
  const { prisma, redis } = deps;
  const log: LeaderboardServiceLog = deps.log ?? { warn: () => {} };

  async function getRefreshedAt(): Promise<string> {
    try {
      const val = await redis.get(REFRESHED_AT_KEY);
      return val ?? new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  async function getLeaderboard(kindStr: string): Promise<LeaderboardRes> {
    const kind = KIND_MAP[kindStr.toLowerCase()];
    if (kind === undefined) {
      throw new ValidationError(`無效的排行榜類型：${kindStr}（須為 daily/weekly/total）`);
    }

    const periodKey =
      kind === LeaderboardKind.DAILY   ? getTodayDateKey() :
      kind === LeaderboardKind.WEEKLY  ? getWeeklyPeriodKey() :
      null;

    let rows: ViewRow[] = [];
    try {
      if (kind === LeaderboardKind.DAILY) {
        rows = await prisma.$queryRaw<ViewRow[]>`
          SELECT v.user_id, v.net_win::BIGINT::TEXT AS score, u.username, u.avatar_id
          FROM leaderboard_daily v
          JOIN users u ON u.id = v.user_id
          ORDER BY v.net_win DESC
        `;
      } else if (kind === LeaderboardKind.WEEKLY) {
        rows = await prisma.$queryRaw<ViewRow[]>`
          SELECT v.user_id, v.net_win::BIGINT::TEXT AS score, u.username, u.avatar_id
          FROM leaderboard_weekly v
          JOIN users u ON u.id = v.user_id
          ORDER BY v.net_win DESC
        `;
      } else {
        rows = await prisma.$queryRaw<ViewRow[]>`
          SELECT v.user_id, v.score::TEXT AS score, u.username, u.avatar_id
          FROM leaderboard_total v
          JOIN users u ON u.id = v.user_id
          ORDER BY v.score DESC
        `;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'leaderboard: 視圖查詢失敗（非 PG 環境？）');
    }

    const refreshedAt = await getRefreshedAt();

    return {
      kind,
      periodKey,
      entries: rows.map((row, idx) => ({
        rank: idx + 1,
        userId: row.user_id,
        username: row.username,
        avatarId: Number(row.avatar_id),
        score: String(row.score),
      })),
      refreshedAt,
    };
  }

  async function refreshViews(): Promise<void> {
    try {
      await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_daily`;
      await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_weekly`;
      await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_total`;
      await redis.set(REFRESHED_AT_KEY, new Date().toISOString());
      log.info?.({}, 'leaderboard: 3 視圖已刷新');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'leaderboard: 視圖刷新失敗（非 PG 環境？）');
    }
  }

  async function snapshotDailyTop100(): Promise<void> {
    // Asia/Taipei 昨日 UTC 邊界（UTC+8, 無 DST）
    const TPE_OFFSET_MS = 8 * 60 * 60 * 1_000;
    const nowMs = Date.now();
    const nowTpe = new Date(nowMs + TPE_OFFSET_MS);
    // 今日 Taipei midnight UTC timestamp
    const todayTpeMidnightUtc =
      new Date(
        Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth(), nowTpe.getUTCDate()),
      ).getTime() - TPE_OFFSET_MS;

    const startUtc = new Date(todayTpeMidnightUtc - 86_400_000);
    const endUtc   = new Date(todayTpeMidnightUtc);

    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
    const periodKey = fmt.format(new Date(nowMs - 86_400_000)); // 昨日日期字串

    try {
      const rows = await prisma.$queryRaw<Array<{ user_id: string; net_win: bigint }>>`
        SELECT user_id, SUM(payout - amount)::BIGINT AS net_win
        FROM bet_records
        WHERE created_at >= ${startUtc} AND created_at < ${endUtc}
        GROUP BY user_id
        ORDER BY net_win DESC
        LIMIT 100
      `;

      if (rows.length === 0) {
        log.info?.({ periodKey }, 'leaderboard: 昨日無下注記錄，跳過快照');
        return;
      }

      await prisma.leaderboardSnapshot.createMany({
        data: rows.map((row, idx) => ({
          kind: LeaderboardKind.DAILY,
          periodKey,
          rank: idx + 1,
          userId: row.user_id,
          score: row.net_win,
        })),
        skipDuplicates: true,
      });

      log.info?.({ periodKey, count: rows.length }, 'leaderboard: 每日 Top100 快照寫入完成');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'leaderboard: 每日快照失敗（非 PG 環境？）');
    }
  }

  return { getLeaderboard, refreshViews, snapshotDailyTop100 };
}

export type LeaderboardService = ReturnType<typeof createLeaderboardService>;
