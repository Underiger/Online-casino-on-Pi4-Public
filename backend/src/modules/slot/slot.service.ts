/**
 * Slot spin 服務（05_MILESTONES M11、02_TDD §2 slot.service.ts、01_GDD §3）。
 *
 * 主流程（spin）：
 *   1. 注額檔位驗證（zod 已在路由層擋，此處防禦性複驗）
 *   2. CompiledLoadout：Redis `slot:loadout:{userId}` 快取讀取，
 *      miss / 損毀 / 版本不符 → compileLoadoutForUser（DB 取護符 → 純函式編譯）→ 寫回（TTL 24h）
 *   3. serverSeedHash = sha256(rngBytes(32))（02_TDD §5.1 provably-fair 預留）
 *   4. 讀 Redis `slot:pity:{userId}` 保底計數（故障視為 0，僅記日誌）
 *   5. sampler 三軸抽樣（含 CONDITIONAL 變體切換）→ payout 結算（純函式）
 *   6. ★ 單一 PG 交易：Jackpot 觸發判定（以本次旋轉前的 jackpotPoints 計算，
 *      GDD §3.4.2）→ BetRecord（detail 含 jackpotTriggered）→ wallet.debit（條件扣款）
 *      → 贏分 wallet.credit → jackpotPoints 累加 —— 任一步失敗整筆回滾、零落帳
 *   7. 交易提交後：pity 計數更新（中獎 DEL / 未中 INCR）、jackpotService.accumulate(1%)、
 *      異常偵測統計 —— 皆「失敗僅記日誌」，永不影響已提交的交易結果
 *   8. M14：若觸發 Jackpot → jackpotService.payout(userId)（交易之外執行——派彩
 *      內含強制 flush 與樂觀鎖重試，不可被 spin 交易回滾牽連；觸發不影響本次
 *      旋轉的贏分）。派彩失敗僅記錯誤日誌，回應 jackpotPayout 為 null，
 *      BetRecord.detail.jackpotTriggered 仍為 true 供人工對帳。
 *
 * Redis 失敗語義總表：
 *   loadout 讀取失敗 → 重編譯（等同 cache miss）；寫回失敗 → 下次再編譯
 *   pity 讀取失敗   → 以 0 計（保底延後觸發，不誤發加成）
 *   pity 更新 / jackpot 累積 / anomaly → 記日誌略過
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  LUCKY_SYMBOL_PAYOUT_MULTIPLIER,
  SLOT_BET_AMOUNTS,
  SLOT_PAYTABLE,
  SLOT_SYMBOLS,
  WEIGHT_TABLE_VERSION,
  type SlotSymbol,
} from '../../config/constants.js';
import { rngBytes, rngInt } from '../../security/csprng.js';
import { LoadoutCompileError, ValidationError } from '../../shared/errors.js';
import type { WalletService } from '../wallet/wallet.service.js';
import type { JackpotService } from '../jackpot/jackpot.service.js';
import { compileLoadout } from './loadout-compiler.js';
import { sampleSpin, type RngFn } from './sampler.js';
import { settlePayout } from './payout.js';
import type { CompiledLoadout, EquippedCharm, SlotReels } from './slot.types.js';

// ─────────────────────────── Redis keys ───────────────────────────

export const SLOT_LOADOUT_KEY_PREFIX = 'slot:loadout:';
export const SLOT_PITY_KEY_PREFIX = 'slot:pity:';
/** 今日幸運符號（全服一枚；M18 daily-reset job 寫入並批量失效 loadout 快取） */
export const DAILY_LUCKY_SYMBOL_KEY = 'daily:lucky-symbol';
/** loadout 快取 TTL（GDD §3.3.2 步驟 4：24h） */
export const SLOT_LOADOUT_TTL_SECONDS = 86_400;

export function loadoutCacheKey(userId: string): string {
  return `${SLOT_LOADOUT_KEY_PREFIX}${userId}`;
}

export function pityCounterKey(userId: string): string {
  return `${SLOT_PITY_KEY_PREFIX}${userId}`;
}

// ─────────────────────────── 型別 ───────────────────────────

/**
 * Redis 快取封包：CompiledLoadout 本體不含 luckySymbol / 護符 codes，
 * 但結算（PayoutInput.luckySymbol）與 BetRecord.detail.charmsUsed 都需要，
 * 故快取一併封存——三者來自同一次編譯，hash 一致性由 loadoutHash 保證。
 */
export interface CachedLoadout {
  loadout: CompiledLoadout;
  luckySymbol: SlotSymbol | null;
  charmCodes: string[];
}

/** spin 結果（路由層序列化為 docs/04_API_SPEC.md §3.4 SpinRes） */
export interface SpinOutcome {
  betRecordId: string;
  betAmount: number;
  reels: SlotReels;
  /** 贏分（0 = 未中獎）；對齊 API 規格欄位名 payout */
  payout: number;
  newBalance: bigint;
  pityActive: boolean;
  pityCounter: number;
  jackpotTriggered: boolean;
  /** 觸發且派彩成功時的派彩金額；未觸發或派彩失敗為 null（M14） */
  jackpotPayout: bigint | null;
  jackpotPoints: number;
  luckySymbol: SlotSymbol | null;
  serverSeedHash: string;
}

export interface SlotHistoryItem {
  id: string;
  betAmount: number;
  reels: SlotReels | null;
  payout: number;
  jackpotTriggered: boolean;
  createdAt: Date;
}

export interface SlotHistoryResult {
  items: SlotHistoryItem[];
  total: number;
  page: number;
  limit: number;
}

export interface PaytableEntry {
  symbol: SlotSymbol;
  tripleMultiplier: number;
  doubleMultiplier: number | null;
  isWild: boolean;
}

export interface PaytableResult {
  entries: PaytableEntry[];
  luckySymbol: SlotSymbol | null;
  luckyMultiplierBonus: number;
}

/** 最小日誌介面（fastify logger 與測試 fake 皆滿足；error 缺省時降級用 warn） */
export interface SlotLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface SlotServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  jackpot: Pick<JackpotService, 'accumulate' | 'tryTriggerJackpot' | 'payout'>;
  /** 異常下注統計（M06 骨架；recordBet 自吞 Redis 錯誤） */
  anomaly?: { recordBet: (userId: string, amount: bigint, payout: bigint) => Promise<unknown> };
  log?: SlotLog;
  /** 注入式 rng（預設 csprng rngInt）；單元測試以決定性序列驅動盤面 */
  rng?: RngFn;
}

// ─────────────────────────── 工具 ───────────────────────────

function isSlotSymbol(value: unknown): value is SlotSymbol {
  return typeof value === 'string' && (SLOT_SYMBOLS as readonly string[]).includes(value);
}

/** 快取 JSON → CachedLoadout；任何結構不符回 null（等同 miss，重編譯救回） */
export function parseCachedLoadout(raw: string): CachedLoadout | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const env = data as Partial<CachedLoadout>;
  const loadout = env.loadout;
  if (
    typeof loadout !== 'object' ||
    loadout === null ||
    typeof loadout.loadoutHash !== 'string' ||
    !Array.isArray(loadout.reels) ||
    loadout.reels.length !== 3 ||
    typeof loadout.rules !== 'object' ||
    loadout.rules === null ||
    typeof loadout.version !== 'number'
  ) {
    return null;
  }
  if (!Array.isArray(env.charmCodes) || !env.charmCodes.every((c) => typeof c === 'string')) {
    return null;
  }
  if (env.luckySymbol !== null && !isSlotSymbol(env.luckySymbol)) return null;
  return { loadout, luckySymbol: env.luckySymbol, charmCodes: env.charmCodes };
}

// ─────────────────────────── service ───────────────────────────

export function createSlotService(deps: SlotServiceDeps) {
  const { prisma, redis, wallet, jackpot } = deps;
  const log: SlotLog = deps.log ?? { warn: () => {} };
  const rng: RngFn = deps.rng ?? rngInt;

  /** 今日幸運符號（M18 寫入；缺鍵 / 非法值 / Redis 故障一律 null） */
  async function getTodayLuckySymbol(): Promise<SlotSymbol | null> {
    try {
      const raw = await redis.get(DAILY_LUCKY_SYMBOL_KEY);
      return isSlotSymbol(raw) ? raw : null;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'slot: 幸運符號讀取失敗，視為未設定');
      return null;
    }
  }

  /**
   * DB 取已裝備護符 → compileLoadout（GDD §3.3.2 步驟 4 的 miss 路徑）。
   * DB / 編譯任何異常 → LoadoutCompileFailed 500（玩家不可自行修復）。
   */
  async function compileLoadoutForUser(userId: string): Promise<CachedLoadout> {
    const luckySymbol = await getTodayLuckySymbol();
    try {
      const rows = await prisma.userCharm.findMany({
        where: { userId, equipped: true, charm: { enabled: true } },
        select: { charm: { select: { code: true, type: true, effect: true } } },
        orderBy: { slot: 'asc' },
      });
      const charms: EquippedCharm[] = rows.map((row) => ({
        code: row.charm.code,
        type: row.charm.type,
        effect: row.charm.effect,
      }));
      const loadout = compileLoadout({ userId, charms, luckySymbol });
      return { loadout, luckySymbol, charmCodes: charms.map((c) => c.code) };
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'slot: loadout 編譯失敗');
      throw new LoadoutCompileError();
    }
  }

  /** 快取讀取 → miss / 損毀 / 舊版本 → 重編譯 → 寫回（寫回失敗僅記日誌） */
  async function getLoadout(userId: string): Promise<CachedLoadout> {
    const key = loadoutCacheKey(userId);
    try {
      const raw = await redis.get(key);
      if (raw !== null) {
        const cached = parseCachedLoadout(raw);
        // 版本不符＝調參後舊快取（loadoutHash 含版本），直接作廢重編譯
        if (cached !== null && cached.loadout.version === WEIGHT_TABLE_VERSION) {
          return cached;
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'slot: loadout 快取讀取失敗，改走重編譯');
    }

    const fresh = await compileLoadoutForUser(userId);
    try {
      await redis.set(key, JSON.stringify(fresh), 'EX', SLOT_LOADOUT_TTL_SECONDS);
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'slot: loadout 快取寫回失敗');
    }
    return fresh;
  }

  /** 進場保底計數（GDD §3.3.2 步驟 7）；故障以 0 計——寧可延後保底，不誤發加成 */
  async function readPityCounter(userId: string): Promise<number> {
    try {
      const raw = await redis.get(pityCounterKey(userId));
      if (raw === null) return 0;
      const n = Number(raw);
      return Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'slot: pity 讀取失敗，以 0 計');
      return 0;
    }
  }

  /** 旋轉後計數：中獎歸零（DEL）、未中 +1（INCR）——對齊 payout.pityCounterAfter 語義 */
  async function updatePityCounter(userId: string, won: boolean): Promise<void> {
    try {
      if (won) {
        await redis.del(pityCounterKey(userId));
      } else {
        await redis.incr(pityCounterKey(userId));
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'slot: pity 更新失敗（下次讀取自然校正）');
    }
  }

  return {
    // 測試 / paytable 路由需要；亦供 M13 裝備變更後主動重編譯複用
    getTodayLuckySymbol,
    compileLoadoutForUser,
    getLoadout,

    /** POST /api/slot/spin 主流程（檔頭流程說明） */
    async spin(userId: string, betAmount: number): Promise<SpinOutcome> {
      // 防禦性複驗（路由層 zod 已擋；service 可能被 Socket M12+ 直接呼叫）
      if (!(SLOT_BET_AMOUNTS as readonly number[]).includes(betAmount)) {
        throw new ValidationError(`注額僅限 ${SLOT_BET_AMOUNTS.join(' / ')}`);
      }

      const cached = await getLoadout(userId);
      const pityCounter = await readPityCounter(userId);

      // provably-fair 預留：每筆 spin 一顆 32-byte seed，只落 hash（02_TDD §5.1）
      const serverSeedHash = createHash('sha256').update(rngBytes(32)).digest('hex');

      const reels = sampleSpin(cached.loadout, rng);
      const result = settlePayout({
        reels,
        betAmount,
        rules: cached.loadout.rules,
        pityCounter,
        luckySymbol: cached.luckySymbol,
      });
      const won = result.winAmount > 0;

      // ── 單一 PG 交易：觸發判定 → BetRecord → 扣款 → 賠付 → jackpotPoints（失敗整筆回滾） ──
      const txOut = await prisma.$transaction(async (tx) => {
        // Jackpot 觸發判定（GDD §3.4.2）：以本次旋轉「前」的點數計算機率修正
        // （Diamond 本次給點不追溯生效）；同交易讀取確保與 BetRecord 一致
        const { jackpotPoints: pointsBefore } = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { jackpotPoints: true },
        });
        const jackpotTriggered = jackpot.tryTriggerJackpot(pointsBefore);

        const betRecord = await tx.betRecord.create({
          data: {
            userId,
            gameType: 'SLOT',
            amount: BigInt(betAmount),
            payout: BigInt(result.winAmount),
            serverSeedHash,
            detail: {
              reels,
              charmsUsed: cached.charmCodes,
              pityActive: result.pityApplied,
              luckySymbol: cached.luckySymbol,
              lineKind: result.lineKind,
              wildUsed: result.wildUsed,
              luckyApplied: result.luckyApplied,
              jackpotPointsEarned: result.jackpotPointsEarned,
              jackpotTriggered,
            },
          },
        });

        // 條件扣款（餘額不足拋 422 → 整筆回滾，BetRecord 一併消失）
        const debit = await wallet.debit(userId, BigInt(betAmount), 'BET', {
          tx,
          refId: betRecord.id,
        });
        let newBalance = debit.balance;

        if (won) {
          const credit = await wallet.credit(userId, BigInt(result.winAmount), 'PAYOUT', {
            tx,
            refId: betRecord.id,
          });
          newBalance = credit.balance;
        }

        // jackpotPoints 非餘額欄位，wallet 鐵律不適用；同交易確保與 BetRecord 一致
        let jackpotPoints = pointsBefore;
        if (result.jackpotPointsEarned > 0) {
          const user = await tx.user.update({
            where: { id: userId },
            data: { jackpotPoints: { increment: result.jackpotPointsEarned } },
            select: { jackpotPoints: true },
          });
          jackpotPoints = user.jackpotPoints;
        }

        return { betRecordId: betRecord.id, newBalance, jackpotPoints, jackpotTriggered };
      });

      // ── 交易已提交：Redis 後置作業，失敗僅記日誌（檔頭失敗語義表） ──
      await updatePityCounter(userId, won);
      await jackpot.accumulate(betAmount); // 1% 進池；內部自吞 Redis 錯誤
      if (deps.anomaly) {
        deps.anomaly
          .recordBet(userId, BigInt(betAmount), BigInt(result.winAmount))
          .catch(() => {}); // 輔助統計，永不影響回應
      }

      // ── M14：觸發即派彩（spin 交易之外——派彩內含強制 flush 與樂觀鎖重試 ≤3，
      // 失敗不可回滾已提交的下注交易）。觸發不影響本次旋轉贏分（GDD §3.4.2）。
      let jackpotPayout: bigint | null = null;
      let jackpotPoints = txOut.jackpotPoints;
      let newBalance = txOut.newBalance;
      if (txOut.jackpotTriggered) {
        try {
          const payoutResult = await jackpot.payout(userId);
          if (payoutResult !== null) {
            jackpotPayout = payoutResult.payout;
            jackpotPoints = 0; // 派彩成功即點數歸零（payout 交易內已落庫）
            newBalance = payoutResult.winnerBalance; // 含派彩入帳的最新餘額
          }
        } catch (err) {
          // 錢未到帳：BetRecord.detail.jackpotTriggered=true 但無 JackpotHistory，
          // 對帳腳本可偵測；回應 jackpotPayout=null，前端不顯示派彩金額
          (log.error ?? log.warn)(
            { err: (err as Error).message, userId, betRecordId: txOut.betRecordId },
            'slot: Jackpot 派彩失敗（觸發已記錄，需人工對帳）',
          );
        }
      }

      return {
        betRecordId: txOut.betRecordId,
        betAmount,
        reels,
        payout: result.winAmount,
        newBalance,
        pityActive: result.pityApplied,
        pityCounter: result.pityCounterAfter,
        jackpotTriggered: txOut.jackpotTriggered,
        jackpotPayout,
        jackpotPoints,
        luckySymbol: cached.luckySymbol,
        serverSeedHash,
      };
    },

    /** GET /api/slot/paytable（docs/04_API_SPEC.md §3.4） */
    async paytable(): Promise<PaytableResult> {
      const luckySymbol = await getTodayLuckySymbol();
      return {
        entries: SLOT_SYMBOLS.map((symbol) => ({
          symbol,
          tripleMultiplier: SLOT_PAYTABLE[symbol].triple,
          doubleMultiplier: SLOT_PAYTABLE[symbol].double,
          isWild: symbol === 'WILD',
        })),
        luckySymbol,
        luckyMultiplierBonus: LUCKY_SYMBOL_PAYOUT_MULTIPLIER,
      };
    },

    /** GET /api/slot/history 旋轉歷史分頁（BetRecord gameType=SLOT） */
    async history(
      userId: string,
      query: { page: number; limit: number },
    ): Promise<SlotHistoryResult> {
      const where = { userId, gameType: 'SLOT' as const };
      const [rows, total] = await Promise.all([
        prisma.betRecord.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: { id: true, amount: true, payout: true, detail: true, createdAt: true },
        }),
        prisma.betRecord.count({ where }),
      ]);

      const items: SlotHistoryItem[] = rows.map((row) => {
        const detail = (row.detail ?? {}) as Record<string, unknown>;
        const rawReels = detail['reels'];
        const reels: SlotReels | null =
          Array.isArray(rawReels) && rawReels.length === 3 && rawReels.every(isSlotSymbol)
            ? (rawReels as SlotReels)
            : null; // 防禦：detail 由本 service 寫入，理論上不會發生
        return {
          id: row.id,
          betAmount: Number(row.amount),
          reels,
          payout: Number(row.payout),
          jackpotTriggered: detail['jackpotTriggered'] === true,
          createdAt: row.createdAt,
        };
      });

      return { items, total, page: query.page, limit: query.limit };
    },
  };
}

export type SlotService = ReturnType<typeof createSlotService>;
