/**
 * Achievement 服務（01_GDD §5.4、05_MILESTONES M20）。
 *
 * 職責：
 *   1. tryUnlock     — 原子解鎖成就（UserAchievement + wallet.credit，$transaction 保障）
 *   2. checkSpinMilestone      — SPIN_1000（累計旋轉 1,000 次）
 *   3. checkRouletteMilestone  — ROULETTE_100（累計輪盤 100 局）
 *   4. checkChatMilestone      — CHATTERBOX（累計發言 100 則）
 *   5. checkCharmMilestone     — CHARM_COLLECT_6 / CHARM_COLLECT_12
 *   6. checkDailyNetWin        — NET_WIN_10000（當日淨贏 10,000 Coin）
 *   7. getUserAchievements     — 全成就列表（含解鎖狀態）
 *
 * 設計原則：
 * - tryUnlock 冪等：重複呼叫同一 code 僅第一次執行交易，後續直接返回 false。
 * - 所有 stat-based 檢查於確認未解鎖後才計算計數（避免無謂 DB 查詢）。
 * - 所有整合點採 fire-and-forget（void + .catch()），不阻塞主流程回應。
 * - io 選填：未傳入時僅寫庫、不推送 Socket 事件。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { GameType } from '@prisma/client';
import { SOCKET_EVENTS } from '../../sockets/events.js';
import type { WalletService } from '../wallet/wallet.service.js';

// ─── 型別 ─────────────────────────────────────────────────────────────────────

export interface AchievementServiceLog {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface AchievementServiceDeps {
  prisma: PrismaClient;
  wallet: WalletService;
  log?: AchievementServiceLog;
}

type Emitter = {
  to: (room: string) => { emit: (event: string, data: unknown) => void };
};

export interface AchievementItem {
  achievementId: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: string;
  unlockedAt: string | null;
}

export interface UserAchievementsRes {
  items: AchievementItem[];
}

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

function getTodayStartUtc(): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
  const today = fmt.format(new Date()); // "YYYY-MM-DD"
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  // Midnight Asia/Taipei (UTC+8) converted to UTC
  return new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1_000);
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createAchievementService(deps: AchievementServiceDeps) {
  const { prisma, wallet } = deps;
  const log: AchievementServiceLog = deps.log ?? { warn: () => {} };

  /**
   * 嘗試解鎖指定成就。
   * - 已解鎖或成就不存在：立即返回 false（不拋錯）。
   * - 首次解鎖：$transaction（建立 UserAchievement + wallet.credit）+ Socket 推送。
   * - 並發競態：unique constraint 衝突視為已解鎖，返回 false。
   * @returns true 若此次呼叫完成了解鎖；false 若已解鎖或成就不存在
   */
  async function tryUnlock(
    userId: string,
    code: string,
    io?: Emitter,
  ): Promise<boolean> {
    const ach = await prisma.achievement.findUnique({ where: { code } });
    if (ach === null) {
      log.warn({ code }, 'achievement: 成就代碼不存在');
      return false;
    }

    // 快速退出：已解鎖則無需開交易
    const existing = await prisma.userAchievement.findUnique({
      where: { userId_achievementId: { userId, achievementId: ach.id } },
      select: { id: true },
    });
    if (existing !== null) return false;

    let newBalance!: bigint;
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.userAchievement.create({ data: { userId, achievementId: ach.id } });
        const result = await wallet.credit(userId, ach.rewardCoin, 'TASK_REWARD', {
          tx,
          memo: `成就解鎖：${ach.code}`,
        });
        newBalance = result.balance;
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) return false; // 並發競態，視為已解鎖
      log.warn({ err: (err as Error).message, userId, code }, 'achievement: tryUnlock 失敗');
      return false;
    }

    io?.to(`user:${userId}`).emit(SOCKET_EVENTS.ACHIEVEMENT_UNLOCKED, {
      achievementId: ach.id,
      code: ach.code,
      name: ach.name,
      description: ach.description,
      rewardCoin: ach.rewardCoin.toString(),
      newBalance: newBalance.toString(),
    });

    log.info?.({ userId, code }, 'achievement: 成就解鎖成功');
    return true;
  }

  // ── 共用「是否已解鎖」快速檢查（用於 stat-based 避免計數查詢） ──────────────

  async function isUnlocked(userId: string, code: string): Promise<boolean> {
    const row = await prisma.userAchievement.findFirst({
      where: { userId, achievement: { code } },
      select: { id: true },
    });
    return row !== null;
  }

  // ── stat-based 成就檢查（供各模組 fire-and-forget 呼叫） ─────────────────────

  /** 老虎機累計 1,000 次（SPIN_1000）*/
  async function checkSpinMilestone(userId: string, io?: Emitter): Promise<void> {
    if (await isUnlocked(userId, 'SPIN_1000')) return;
    const count = await prisma.betRecord.count({ where: { userId, gameType: GameType.SLOT } });
    if (count >= 1_000) await tryUnlock(userId, 'SPIN_1000', io);
  }

  /** 輪盤累計 100 局（ROULETTE_100）*/
  async function checkRouletteMilestone(userId: string, io?: Emitter): Promise<void> {
    if (await isUnlocked(userId, 'ROULETTE_100')) return;
    const count = await prisma.betRecord.count({ where: { userId, gameType: GameType.ROULETTE } });
    if (count >= 100) await tryUnlock(userId, 'ROULETTE_100', io);
  }

  /** 聊天室累計 100 則（CHATTERBOX）*/
  async function checkChatMilestone(userId: string, io?: Emitter): Promise<void> {
    if (await isUnlocked(userId, 'CHATTERBOX')) return;
    const count = await prisma.chatMessage.count({ where: { userId } });
    if (count >= 100) await tryUnlock(userId, 'CHATTERBOX', io);
  }

  /** 護符收集 6 / 12 枚（CHARM_COLLECT_6 / CHARM_COLLECT_12）*/
  async function checkCharmMilestone(userId: string, io?: Emitter): Promise<void> {
    const count = await prisma.userCharm.count({ where: { userId } });
    if (count >= 6) await tryUnlock(userId, 'CHARM_COLLECT_6', io);
    if (count >= 12) await tryUnlock(userId, 'CHARM_COLLECT_12', io);
  }

  /** 當日淨贏累計 10,000 Coin（NET_WIN_10000）*/
  async function checkDailyNetWin(userId: string, io?: Emitter): Promise<void> {
    if (await isUnlocked(userId, 'NET_WIN_10000')) return;
    const todayStart = getTodayStartUtc();
    const agg = await prisma.betRecord.aggregate({
      where: { userId, createdAt: { gte: todayStart } },
      _sum: { payout: true, amount: true },
    });
    const netWin = (agg._sum.payout ?? 0n) - (agg._sum.amount ?? 0n);
    if (netWin >= 10_000n) await tryUnlock(userId, 'NET_WIN_10000', io);
  }

  // ── 查詢 API ─────────────────────────────────────────────────────────────────

  /** 回傳全部成就 + 使用者解鎖狀態（用於 GET /api/user/achievements） */
  async function getUserAchievements(userId: string): Promise<UserAchievementsRes> {
    const [all, unlocked] = await Promise.all([
      prisma.achievement.findMany({ orderBy: { name: 'asc' } }),
      prisma.userAchievement.findMany({
        where: { userId },
        select: { achievementId: true, unlockedAt: true },
      }),
    ]);

    const unlockedMap = new Map(unlocked.map((u) => [u.achievementId, u.unlockedAt]));

    return {
      items: all.map((ach) => ({
        achievementId: ach.id,
        code: ach.code,
        name: ach.name,
        description: ach.description,
        rewardCoin: ach.rewardCoin.toString(),
        unlockedAt: unlockedMap.get(ach.id)?.toISOString() ?? null,
      })),
    };
  }

  return {
    tryUnlock,
    checkSpinMilestone,
    checkRouletteMilestone,
    checkChatMilestone,
    checkCharmMilestone,
    checkDailyNetWin,
    getUserAchievements,
  };
}

export type AchievementService = ReturnType<typeof createAchievementService>;
