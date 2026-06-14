/**
 * Jackpot 模組（01_GDD §3.4、02_TDD §6.3、05_MILESTONES M14）。
 * M11 落地「累積增量」接口；M14 補齊 flush、觸發判定、樂觀鎖派彩、開機校準。
 *
 * Redis keys（GDD §3.4.1）：
 *   jackpot:pool    — 展示用即時值（= DB pool + 未落庫增量；restoreLivePool 開機校準）
 *   jackpot:delta   — 尚未 flush 落庫的增量（flush 以 GETSET 歸零原子取走）
 *   jackpot:txcount — 自上次 flush 起的下注筆數（≥500 由 tick job 觸發提前 flush）
 *   jackpot:centi   — ★ centi-coin 進位累進器（M11 新增）：
 *       1% 貢獻對 10/50 注額是 0.1/0.5 Coin，逐筆 floor 會讓小額注的貢獻永久歸零；
 *       改以 centi-coin 累進（1 Coin = 100 centi；betAmount 的 1% 恰等於 betAmount centi），
 *       INCRBY 跨過百位才進位整數 Coin 到 pool/delta。INCRBY 回傳值唯一且單調，
 *       進位量 = floor(新值/100) − floor(舊值/100)，併發下不重不漏。
 *
 * 一致性設計（GDD §3.4）：
 *   - 真值來源：PostgreSQL `Jackpot.pool`（單行表 id=1）；Redis 僅是「尚未落庫的
 *     增量 + 展示值」。重啟恢復：pool(DB) + delta(Redis)。
 *   - flush：GETSET delta 0 原子取增量 → PG `pool = pool + delta`（單行 increment，
 *     原子無需條件）；PG 失敗時把增量 INCRBY 放回 delta，下次 flush 重收（不遺失）。
 *   - 派彩：先強制 flush → 樂觀鎖條件更新（WHERE version = :v，行數 0 重試 ≤3）
 *     → 同一 PG 交易內：pool 留底 20% + JackpotHistory + wallet.credit（餘額鐵律：
 *     必走 wallet 模組落 BalanceTransaction）+ 中獎者 jackpotPoints 歸零。
 *   - 廣播 / 聊天室系統訊息屬交易後置：失敗僅記日誌，派彩結果不受影響。
 *
 * 失敗語義：Redis 故障僅記日誌——Jackpot 累積 / flush / 展示永不阻斷下注主交易
 * （GDD §3.4.1）；唯派彩的 PG 交易失敗會拋錯（錢未到帳，呼叫方必須知道）。
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { rngInt } from '../../security/csprng.js';
import { OptimisticLockError } from '../../shared/errors.js';
import { SOCKET_EVENTS } from '../../sockets/events.js';
import type { WalletService } from '../wallet/wallet.service.js';

export const JACKPOT_POOL_KEY = 'jackpot:pool';
export const JACKPOT_DELTA_KEY = 'jackpot:delta';
export const JACKPOT_TXCOUNT_KEY = 'jackpot:txcount';
export const JACKPOT_CENTI_KEY = 'jackpot:centi';

/** 每注貢獻比例：1%（與 packages/shared JACKPOT_CONTRIBUTION_RATE 鏡像；centi 換算已內建） */
export const JACKPOT_CONTRIBUTION_PERCENT = 1;

/** Jackpot 單行表固定主鍵（migration 內含種子行） */
export const JACKPOT_ROW_ID = 1;

/** 基礎觸發分母：1/50,000（與 packages/shared JACKPOT_BASE_ODDS 鏡像） */
export const JACKPOT_BASE_ODDS = 50_000;
/** 點數修正後的機率上限：1/5,000（GDD §3.4.2） */
export const JACKPOT_MIN_ODDS = 5_000;
/** 點數修正：每 100 點 +10% 相對機率 ⇒ 最終機率 = 基礎 × (1 + points/1000) */
export const JACKPOT_POINTS_DIVISOR = 1_000;
/** 派彩比例：中獎者 80%、20% 留底（與 shared JACKPOT_PAYOUT_RATE 鏡像；整數運算用分子/分母） */
export const JACKPOT_PAYOUT_NUMERATOR = 80n;
export const JACKPOT_PAYOUT_DENOMINATOR = 100n;
/** 派彩樂觀鎖重試上限（02_TDD §4：≤3 次） */
export const JACKPOT_PAYOUT_MAX_RETRIES = 3;

/** 最小日誌介面（fastify logger 與測試 fake 皆滿足；error 缺省時降級用 warn） */
export interface JackpotLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

/** 派彩成功的結果（廣播 payload 與 SpinRes 擴充欄位由此組裝） */
export interface JackpotPayoutResult {
  payout: bigint;
  poolBefore: bigint;
  remained: bigint;
  /** 入帳後的中獎者餘額（spin 回應 newBalance 以此覆蓋，前端 server-authoritative） */
  winnerBalance: bigint;
}

export interface JackpotPoolStatus {
  /** 持久真值（DB）+ Redis 未落庫增量的合計（docs/04_API_SPEC.md §3.6） */
  pool: bigint;
  updatedAt: Date;
}

export interface JackpotHistoryEntry {
  id: string;
  userId: string;
  username: string;
  avatarId: number;
  poolBefore: bigint;
  payout: bigint;
  remained: bigint;
  createdAt: Date;
}

export interface JackpotHistoryResult {
  items: JackpotHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface JackpotServiceDeps {
  redis: Redis;
  prisma: PrismaClient;
  /** 派彩入帳必走 wallet（餘額鐵律：BalanceTransaction 全帳可回放） */
  wallet: Pick<WalletService, 'credit'>;
  /** 全服廣播出口（app.io.emit）；未注入時略過廣播（單元測試 / Socket 未掛載） */
  emit?: (event: string, payload: unknown) => void;
  /** 聊天室系統訊息（M17 chat.service）；未注入時略過 */
  chat?: { sendSystemMessage: (content: string) => Promise<unknown> };
  log?: JackpotLog;
  /** 注入式 rng（預設 csprng rngInt）；單元測試以決定性值驅動觸發判定 */
  rng?: (maxExclusive: number) => number;
}

/**
 * 觸發分母（等效整數化機率，GDD §3.4.2）：
 *   ceil(50000 / (1 + points/1000))，下限 5000（機率上限 1/5,000）。
 * 純函式導出供測試直接斷言對照表。
 */
export function triggerDenominator(jackpotPoints: number): number {
  const points = Number.isSafeInteger(jackpotPoints) && jackpotPoints > 0 ? jackpotPoints : 0;
  const denominator = Math.ceil(JACKPOT_BASE_ODDS / (1 + points / JACKPOT_POINTS_DIVISOR));
  return Math.max(denominator, JACKPOT_MIN_ODDS);
}

export function createJackpotService(deps: JackpotServiceDeps) {
  const { redis, prisma, wallet } = deps;
  const log: JackpotLog = deps.log ?? { warn: () => {} };
  const logError = (obj: unknown, msg?: string): void => {
    (log.error ?? log.warn)(obj, msg);
  };
  const rng = deps.rng ?? rngInt;

  /**
   * 將 Redis 增量原子取走並落庫（GDD §3.4.1 批量寫庫）。
   * 回傳實際落庫的增量 Coin；增量為 0 / Redis 故障 / PG 故障皆回 0n、永不拋錯
   * （flush 由 job 與派彩前置呼叫，兩者都不可被 flush 失敗中斷）。
   * PG 失敗時把增量 INCRBY 放回 delta——下次 flush 重收，增量不遺失。
   */
  async function flush(): Promise<bigint> {
    let deltaRaw: string | null;
    try {
      // GETSET 歸零取增量（原子）；txcount 同步重置
      deltaRaw = await redis.getset(JACKPOT_DELTA_KEY, '0');
      await redis.set(JACKPOT_TXCOUNT_KEY, '0');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'jackpot: flush 讀取增量失敗（Redis 不可用）');
      return 0n;
    }

    let delta: bigint;
    try {
      delta = BigInt(deltaRaw ?? '0');
    } catch {
      log.warn({ deltaRaw }, 'jackpot: delta 鍵值損毀，視為 0（已歸零重新累積）');
      return 0n;
    }
    if (delta <= 0n) return 0n;

    try {
      // 單行 increment 原子，無需條件更新；version 仍 +1（與派彩樂觀鎖同欄位，
      // 派彩讀到舊 version 時條件更新自然失敗重試）
      await prisma.jackpot.update({
        where: { id: JACKPOT_ROW_ID },
        data: { pool: { increment: delta }, version: { increment: 1 } },
      });
      return delta;
    } catch (err) {
      // PG 失敗：增量放回 Redis，下次 flush 重收
      try {
        await redis.incrby(JACKPOT_DELTA_KEY, delta.toString());
        log.warn(
          { err: (err as Error).message, delta: delta.toString() },
          'jackpot: flush 落庫失敗，增量已放回 Redis 待下次重收',
        );
      } catch (redisErr) {
        logError(
          {
            err: (err as Error).message,
            redisErr: (redisErr as Error).message,
            delta: delta.toString(),
          },
          'jackpot: flush 落庫失敗且增量放回失敗——增量遺失，需對帳',
        );
      }
      return 0n;
    }
  }

  /**
   * 開機校準展示值：jackpot:pool = pool(DB) + delta(Redis)（GDD §3.4.1 重啟恢復）。
   * 與啟動瞬間的併發 accumulate 存在微小覆寫窗口——展示值容忍誤差，下次中獎
   * 派彩後 DECRBY 仍以真值軌跡演進，不影響帳務。
   */
  async function restoreLivePool(): Promise<void> {
    try {
      const row = await prisma.jackpot.findUnique({
        where: { id: JACKPOT_ROW_ID },
        select: { pool: true },
      });
      const deltaRaw = await redis.get(JACKPOT_DELTA_KEY);
      const delta = BigInt(deltaRaw ?? '0');
      await redis.set(JACKPOT_POOL_KEY, ((row?.pool ?? 0n) + delta).toString());
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'jackpot: 展示值開機校準失敗（不影響服務）');
    }
  }

  return {
    flush,
    restoreLivePool,

    /**
     * 下注累積：betAmount 的 1% 進全服獎池（centi-coin 精度，跨百位才進位）。
     * 回傳本次實際進位的整數 Coin（0 = 尚未跨位）；Redis 故障回 0、不拋錯。
     */
    async accumulate(betAmount: number): Promise<number> {
      if (!Number.isSafeInteger(betAmount) || betAmount <= 0) return 0;
      try {
        // 1% of betAmount（Coin）== betAmount（centi）；INCRBY 原子且回傳唯一新值
        const centiAfter = await redis.incrby(JACKPOT_CENTI_KEY, betAmount);
        const carry =
          Math.floor(centiAfter / 100) - Math.floor((centiAfter - betAmount) / 100);
        if (carry > 0) {
          await Promise.all([
            redis.incrby(JACKPOT_POOL_KEY, carry),
            redis.incrby(JACKPOT_DELTA_KEY, carry),
          ]);
        }
        await redis.incr(JACKPOT_TXCOUNT_KEY);
        return carry;
      } catch (err) {
        log.warn(
          { err: (err as Error).message, betAmount },
          'jackpot: redis 不可用，本次累積略過（增量遺失屬可容忍損耗）',
        );
        return 0;
      }
    },

    /** 展示用即時獎池值（jackpot:tick 廣播用）；Redis 故障回 0n */
    async getLivePool(): Promise<bigint> {
      try {
        const raw = await redis.get(JACKPOT_POOL_KEY);
        return raw === null ? 0n : BigInt(raw);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'jackpot: 讀取展示值失敗');
        return 0n;
      }
    },

    /**
     * 觸發判定（GDD §3.4.2）：rng(ceil(50000 / (1 + points/1000))) === 0，
     * 分母下限 5000。同步純判定（rng 注入），由 slot.service 於 spin 交易內呼叫。
     */
    tryTriggerJackpot(jackpotPoints: number): boolean {
      return rng(triggerDenominator(jackpotPoints)) === 0;
    },

    /**
     * 派彩（GDD §3.4.2 樂觀鎖）：
     *   1. 強制 flush，確保 PG pool 含最新增量
     *   2. 讀 pool/version → payout = floor(pool × 80%)、remained = pool − payout
     *   3. 單一 PG 交易：條件更新 pool（WHERE version = :v，行數 0 → 整筆回滾重試 ≤3）
     *      → JackpotHistory → wallet.credit(JACKPOT, refId=history.id)
     *      → 中獎者 jackpotPoints 歸零（觸發後點數歸零，GDD §3.4.2-1）
     *   4. 交易後置（失敗僅記日誌）：展示值 DECRBY payout（保留派彩窗口內的併發增量）
     *      → jackpot:won 全服廣播（payload 凍結於 docs/04_API_SPEC.md §4.3）
     *      → 聊天室系統訊息
     *
     * 回傳 null = 獎池為空（無可派彩）；重試耗盡拋 OptimisticLockError（409）。
     */
    async payout(userId: string): Promise<JackpotPayoutResult | null> {
      await flush();

      for (let attempt = 1; attempt <= JACKPOT_PAYOUT_MAX_RETRIES; attempt += 1) {
        const row = await prisma.jackpot.findUniqueOrThrow({
          where: { id: JACKPOT_ROW_ID },
          select: { pool: true, version: true },
        });
        const poolBefore = row.pool;
        const payoutAmount = (poolBefore * JACKPOT_PAYOUT_NUMERATOR) / JACKPOT_PAYOUT_DENOMINATOR;
        if (payoutAmount <= 0n) {
          log.warn({ pool: poolBefore.toString(), userId }, 'jackpot: 獎池為空，本次觸發不派彩');
          return null;
        }
        const remained = poolBefore - payoutAmount;

        // STALE 哨兵：樂觀鎖行數 0 時拋出讓 $transaction 回滾，外層捕捉後重試
        const STALE = Symbol('jackpot-version-stale');
        let committed: {
          winner: { username: string; avatarId: number };
          winnerBalance: bigint;
        };
        try {
          committed = await prisma.$transaction(async (tx) => {
            const { count } = await tx.jackpot.updateMany({
              where: { id: JACKPOT_ROW_ID, version: row.version },
              data: { pool: remained, version: { increment: 1 } },
            });
            if (count !== 1) throw STALE;

            const history = await tx.jackpotHistory.create({
              data: {
                jackpotId: JACKPOT_ROW_ID,
                userId,
                poolBefore,
                payout: payoutAmount,
                remained,
              },
            });

            // 餘額鐵律：入帳必走 wallet（同交易、refId 指向 JackpotHistory）
            const credit = await wallet.credit(userId, payoutAmount, 'JACKPOT', {
              tx,
              refId: history.id,
              memo: '全服 Jackpot 派彩（80%）',
            });

            // 觸發後點數歸零；jackpotPoints 非餘額欄位，wallet 鐵律不適用
            const winner = await tx.user.update({
              where: { id: userId },
              data: { jackpotPoints: 0 },
              select: { username: true, avatarId: true },
            });
            return { winner, winnerBalance: credit.balance };
          });
        } catch (err) {
          if (err === STALE) {
            log.warn(
              { attempt, userId, version: row.version },
              'jackpot: 派彩樂觀鎖競態（flush 或併發派彩），重試',
            );
            continue;
          }
          throw err;
        }

        // ── 交易已提交：後置作業失敗僅記日誌，派彩結果不受影響 ──
        try {
          // DECRBY（而非 SET remained）：派彩窗口內 accumulate 的併發增量保留於展示值
          await redis.decrby(JACKPOT_POOL_KEY, payoutAmount.toString());
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'jackpot: 派彩後展示值更新失敗');
        }

        try {
          deps.emit?.(SOCKET_EVENTS.JACKPOT_WON, {
            userId,
            username: committed.winner.username,
            avatarId: committed.winner.avatarId,
            payout: payoutAmount.toString(),
            poolBefore: poolBefore.toString(),
          });
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'jackpot: jackpot:won 廣播失敗');
        }

        if (deps.chat !== undefined) {
          try {
            await deps.chat.sendSystemMessage(
              `🏆 ${committed.winner.username} 中了全服 Jackpot，贏得 ${payoutAmount.toString()} Coin！獎池留底 ${remained.toString()} Coin 繼續累積。`,
            );
          } catch (err) {
            log.warn({ err: (err as Error).message }, 'jackpot: 系統訊息發送失敗');
          }
        }

        return {
          payout: payoutAmount,
          poolBefore,
          remained,
          winnerBalance: committed.winnerBalance,
        };
      }

      // 單行表上連續 3 次競態幾乎只可能是 flush job 高頻搶寫——拋錯讓呼叫方記錄
      logError({ userId }, 'jackpot: 派彩樂觀鎖重試耗盡（錢未到帳，觸發記錄需人工對帳）');
      throw new OptimisticLockError('Jackpot 派彩競態重試耗盡');
    },

    /** GET /api/jackpot/pool：pool(DB) + delta(Redis)（Redis 故障時退化為 DB 真值） */
    async getPoolStatus(): Promise<JackpotPoolStatus> {
      const row = await prisma.jackpot.findUniqueOrThrow({
        where: { id: JACKPOT_ROW_ID },
        select: { pool: true, updatedAt: true },
      });
      let delta = 0n;
      try {
        const raw = await redis.get(JACKPOT_DELTA_KEY);
        delta = BigInt(raw ?? '0');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'jackpot: 讀取未落庫增量失敗，僅回 DB 真值');
      }
      return { pool: row.pool + delta, updatedAt: row.updatedAt };
    },

    /** GET /api/jackpot/history：歷史中獎分頁（JOIN user 取 username/avatarId） */
    async getHistory(query: { page: number; limit: number }): Promise<JackpotHistoryResult> {
      const [rows, total] = await Promise.all([
        prisma.jackpotHistory.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: {
            id: true,
            userId: true,
            poolBefore: true,
            payout: true,
            remained: true,
            createdAt: true,
            user: { select: { username: true, avatarId: true } },
          },
        }),
        prisma.jackpotHistory.count(),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          username: row.user.username,
          avatarId: row.user.avatarId,
          poolBefore: row.poolBefore,
          payout: row.payout,
          remained: row.remained,
          createdAt: row.createdAt,
        })),
        total,
        page: query.page,
        limit: query.limit,
      };
    },
  };
}

export type JackpotService = ReturnType<typeof createJackpotService>;
