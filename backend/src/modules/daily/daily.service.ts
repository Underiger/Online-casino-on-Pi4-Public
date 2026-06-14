/**
 * Daily System 服務（01_GDD §5.1、02_TDD §3 daily/、05_MILESTONES M18）。
 *
 * 職責：
 *   1. claimDailyLogin — 每日首次登入獎勵（loginStreak 維護 + wallet.credit DAILY_REWARD）
 *   2. getDailyTasks   — 查詢/初始化當日 3 筆隨機任務進度
 *   3. updateProgress  — 任務類型進度遞增（slot/roulette/chat 各模組呼叫），
 *                         可選傳入 io 以即時推送 daily:task_updated
 *   4. claimTask       — 驗證完成狀態並領取獎勵（coin + 可選護符抽取）
 *   5. resetDailyTasks — BullMQ 00:00 cron 呼叫：更換幸運符號 + 清除 slot loadout 快取
 */
import type { PrismaClient, TaskType } from '@prisma/client';
import type { Redis } from 'ioredis';
import { rngInt } from '../../security/csprng.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { SOCKET_EVENTS } from '../../sockets/events.js';
import { SLOT_SYMBOLS } from '../../config/constants.js';

// ─── 常數 ─────────────────────────────────────────────────────────────────────

export const DAILY_LUCKY_SYMBOL_KEY = 'daily:lucky-symbol';
const SLOT_LOADOUT_KEY_PREFIX = 'slot:loadout:';
/** 幸運符號 Redis TTL：26 小時，確保跨日重設後不會提前消失 */
const LUCKY_SYMBOL_TTL_SECONDS = 26 * 60 * 60;
/** 每日任務數量 */
const DAILY_TASK_COUNT = 3;
/** 登入獎勵基礎金額（Coin） */
const BASE_DAILY_REWARD = 100n;

// ─── 型別 ─────────────────────────────────────────────────────────────────────

type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

type Emitter = {
  to: (room: string) => { emit: (event: string, data: unknown) => void };
};

export interface DailyServiceLog {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface DailyServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  log?: DailyServiceLog;
}

export interface DailyLoginRes {
  reward: string;
  streak: number;
  multiplier: number;
  newBalance: string;
}

export interface DailyTaskItem {
  id: string;
  taskId: string;
  code: string;
  name: string;
  type: TaskType;
  target: number;
  progress: number;
  claimed: boolean;
  claimedAt: string | null;
  rewardCoin: string;
  rewardCharm: boolean;
}

export interface DailyTasksRes {
  tasks: DailyTaskItem[];
  luckySymbol: SlotSymbol | null;
  dateKey: string;
}

export interface ClaimTaskRes {
  taskId: string;
  coin: string;
  charmId: string | null;
  newBalance: string;
}

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

function getTodayDateKey(): string {
  // en-CA locale 給出 ISO 格式 "YYYY-MM-DD"，Asia/Taipei 時區
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function calcLoginReward(streak: number): { rewardCoin: bigint; multiplier: number } {
  // streak >= 7 → 2.0x，streak >= 3 → 1.5x，其餘 1.0x
  const multiplier = streak >= 7 ? 2.0 : streak >= 3 ? 1.5 : 1.0;
  return {
    rewardCoin: BigInt(Math.round(Number(BASE_DAILY_REWARD) * multiplier)),
    multiplier,
  };
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rngInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createDailyService(deps: DailyServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: DailyServiceLog = deps.log ?? { warn: () => {} };

  // ── 今日幸運符號（缺鍵/非法/故障 → null）──────────────────────────────────

  async function getTodayLuckySymbol(): Promise<SlotSymbol | null> {
    try {
      const raw = await redis.get(DAILY_LUCKY_SYMBOL_KEY);
      return (SLOT_SYMBOLS as readonly string[]).includes(raw ?? '')
        ? (raw as SlotSymbol)
        : null;
    } catch {
      return null;
    }
  }

  // ── claimDailyLogin ────────────────────────────────────────────────────────

  async function claimDailyLogin(userId: string): Promise<DailyLoginRes> {
    const todayKey = getTodayDateKey();

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { loginStreak: true, lastDailyAt: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');

    // 若 lastDailyAt 在同一個 Asia/Taipei 日期 → 今天已領取
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
    if (user.lastDailyAt !== null && fmt.format(user.lastDailyAt) === todayKey) {
      throw new ConflictError('今日登入獎勵已領取');
    }

    // 判斷連續天數：昨天的 dateKey
    const yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return fmt.format(d);
    })();

    let newStreak: number;
    if (user.lastDailyAt !== null && fmt.format(user.lastDailyAt) === yesterday) {
      newStreak = user.loginStreak + 1;
    } else {
      newStreak = 1;
    }

    const { rewardCoin, multiplier } = calcLoginReward(newStreak);

    // 更新 loginStreak + lastDailyAt（非 balance 欄位，餘額鐵律不適用；
    // 此處例外放行 prisma.user.update——僅寫登入連續天數與時間戳，永不碰 balance）
    // eslint-disable-next-line no-restricted-syntax
    await prisma.user.update({
      where: { id: userId },
      data: { loginStreak: newStreak, lastDailyAt: new Date() },
    });

    const result = await wallet.credit(userId, rewardCoin, 'DAILY_REWARD', {
      memo: `每日登入第 ${newStreak} 天（×${multiplier}）`,
    });

    return {
      reward: rewardCoin.toString(),
      streak: newStreak,
      multiplier,
      newBalance: result.balance.toString(),
    };
  }

  // ── getDailyTasks ──────────────────────────────────────────────────────────

  async function getDailyTasks(userId: string): Promise<DailyTasksRes> {
    const dateKey = getTodayDateKey();

    // 查詢今日已分配進度
    const existing = await prisma.userDailyProgress.findMany({
      where: { userId, dateKey },
      include: { task: true },
    });

    // 不足 3 筆時補選任務
    if (existing.length < DAILY_TASK_COUNT) {
      const existingTaskIds = new Set(existing.map((p) => p.taskId));
      const allEnabled = await prisma.dailyTask.findMany({ where: { enabled: true } });
      const available = allEnabled.filter((t) => !existingTaskIds.has(t.id));
      const needed = DAILY_TASK_COUNT - existing.length;
      const picked = shuffleArray(available).slice(0, needed);

      if (picked.length > 0) {
        await prisma.userDailyProgress.createMany({
          data: picked.map((t) => ({ userId, taskId: t.id, dateKey, progress: 0 })),
          skipDuplicates: true,
        });
      }

      // 重新查詢含新建立的進度
      const refreshed = await prisma.userDailyProgress.findMany({
        where: { userId, dateKey },
        include: { task: true },
      });

      const luckySymbol = await getTodayLuckySymbol();
      return {
        tasks: refreshed.map(toTaskItem),
        luckySymbol,
        dateKey,
      };
    }

    const luckySymbol = await getTodayLuckySymbol();
    return {
      tasks: existing.map(toTaskItem),
      luckySymbol,
      dateKey,
    };
  }

  // ── updateProgress ─────────────────────────────────────────────────────────

  /**
   * 遞增指定任務類型的進度（供 slot/roulette/chat 模組呼叫）。
   * 僅更新今日未完成（progress < target）且未領取的進度。
   * io 不為 null 時即時推送 daily:task_updated 至玩家個人房間。
   */
  async function updateProgress(
    userId: string,
    taskType: TaskType,
    delta: number,
    io?: Emitter,
  ): Promise<void> {
    if (delta <= 0) return;
    const dateKey = getTodayDateKey();

    const rows = await prisma.userDailyProgress.findMany({
      where: {
        userId,
        dateKey,
        claimed: false,
        task: { type: taskType, enabled: true },
      },
      include: { task: { select: { id: true, code: true, target: true } } },
    });

    for (const row of rows) {
      if (row.progress >= row.task.target) continue;

      const newProgress = Math.min(row.progress + delta, row.task.target);
      await prisma.userDailyProgress.update({
        where: { id: row.id },
        data: { progress: newProgress },
      });

      io?.to(`user:${userId}`).emit(SOCKET_EVENTS.DAILY_TASK_UPDATED, {
        taskId: row.task.id,
        progress: newProgress,
        target: row.task.target,
        claimed: false,
      });
    }
  }

  // ── claimTask ──────────────────────────────────────────────────────────────

  async function claimTask(userId: string, progressId: string): Promise<ClaimTaskRes> {
    const prog = await prisma.userDailyProgress.findUnique({
      where: { id: progressId },
      include: { task: true },
    });

    if (prog === null) throw new NotFoundError('進度記錄不存在');
    if (prog.userId !== userId) throw new ForbiddenError('不可領取他人獎勵');
    if (prog.progress < prog.task.target) throw new ConflictError('任務尚未完成');
    if (prog.claimed) throw new ConflictError('獎勵已領取');

    let charmId: string | null = null;
    let newBalance!: bigint;

    await prisma.$transaction(async (tx) => {
      await tx.userDailyProgress.update({
        where: { id: progressId },
        data: { claimed: true, claimedAt: new Date() },
      });

      const res = await wallet.credit(userId, prog.task.rewardCoin, 'TASK_REWARD', {
        tx,
        memo: `每日任務獎勵：${prog.task.code}`,
      });
      newBalance = res.balance;

      if (prog.task.rewardCharm) {
        const charms = await tx.charm.findMany({
          where: { enabled: true },
          select: { id: true },
        });
        if (charms.length > 0) {
          const charm = charms[rngInt(charms.length)]!;
          await tx.userCharm.upsert({
            where: { userId_charmId: { userId, charmId: charm.id } },
            create: { userId, charmId: charm.id },
            update: {},
          });
          charmId = charm.id;
        }
      }
    });

    return {
      taskId: prog.taskId,
      coin: prog.task.rewardCoin.toString(),
      charmId,
      newBalance: newBalance.toString(),
    };
  }

  // ── resetDailyTasks ────────────────────────────────────────────────────────

  /**
   * BullMQ 00:00 Asia/Taipei 呼叫：
   *   1. 隨機選出新幸運符號並寫入 Redis（TTL 26h）
   *   2. SCAN 並批量刪除所有 slot:loadout:* 快取（幸運符號變動 → 舊 loadout 失效）
   */
  async function resetDailyTasks(): Promise<void> {
    const symbol = SLOT_SYMBOLS[rngInt(SLOT_SYMBOLS.length)]!;
    try {
      await redis.set(DAILY_LUCKY_SYMBOL_KEY, symbol, 'EX', LUCKY_SYMBOL_TTL_SECONDS);
      log.info?.({ symbol }, 'daily: 新幸運符號已設定');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'daily: 幸運符號 Redis 寫入失敗');
    }

    // SCAN 刪除所有 slot loadout 快取（可能跨多批次）
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${SLOT_LOADOUT_KEY_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
      log.info?.({ deleted }, 'daily: slot loadout 快取已清除');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'daily: slot loadout 快取清除失敗');
    }
  }

  return { claimDailyLogin, getDailyTasks, updateProgress, claimTask, resetDailyTasks };
}

export type DailyService = ReturnType<typeof createDailyService>;

// ─── 轉換函式 ─────────────────────────────────────────────────────────────────

function toTaskItem(
  row: {
    id: string;
    taskId: string;
    progress: number;
    claimed: boolean;
    claimedAt: Date | null;
    task: {
      code: string;
      name: string;
      type: TaskType;
      target: number;
      rewardCoin: bigint;
      rewardCharm: boolean;
    };
  },
): DailyTaskItem {
  return {
    id: row.id,
    taskId: row.taskId,
    code: row.task.code,
    name: row.task.name,
    type: row.task.type,
    target: row.task.target,
    progress: row.progress,
    claimed: row.claimed,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    rewardCoin: row.task.rewardCoin.toString(),
    rewardCharm: row.task.rewardCharm,
  };
}
