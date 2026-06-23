/**
 * High-Low 服務（規則港自 pokergame/games/high_low.py，見 payout.ts 檔頭）。
 *
 * 四個動作（deal/guess/continueRound/cashOut）都透過同一把 round-lock
 * （security/round-lock.ts）序列化——這個回合的 Redis 狀態會被四種不同動作
 * 讀-改-寫，任何一個動作若不搶鎖，都可能跟另一個併發請求互相踩到（見
 * round-lock.ts 檔頭與本檔孤兒回合段落的詳細說明）。
 *
 * 孤兒回合結算規則（TTL 逾時清理 job 共用，見 jobs/abandoned-round.job.ts）：
 *   卡在 GUESSING（已翻基準牌、尚未猜）→ 沒收目前彩池整包（forfeit）。
 *     這個狀態下「猜高」「猜低」都是賭一個新結果，沒有零成本的安全選項可以代替，
 *     唯一不會被濫用（故意斷線換回退款）的結果就是讓玩家輸——這樣斷線永遠不會
 *     比留著繼續玩更有利。
 *   卡在 RESULT（已猜對、彩池剛翻倍，等待收手或繼續）→ 強制視為收手（auto cash-out）。
 *     這個狀態下「收手」本來就是玩家隨時可以零成本選的選項，逾時等同系統幫他
 *     按了那個鍵，不算讓他白賺。
 *   兩者都絕不是退款（REFUND）——退款等於讓這回合從未發生過，等同免費重練。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import {
  HIGH_LOW_MAX_BET,
  HIGH_LOW_MAX_STREAK,
  HIGH_LOW_MIN_BET,
} from '../../config/constants.js';
import { rngBytes, rngToken } from '../../security/csprng.js';
import { createRoundLock, type RoundLock } from '../../security/round-lock.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type { RngFn } from '../../shared/cards.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { compareGuess, ensureDeckSize, isLegalGuess } from './payout.js';
import type {
  CashOutResult,
  ContinueResult,
  DealResult,
  GuessResult,
  HighLowRoundState,
} from './high-low.types.js';

export const HIGH_LOW_ROUND_KEY_PREFIX = 'high-low:round:';
/** Redis round 狀態 TTL：要比孤兒回合 job 的不活躍判定門檻寬裕得多 */
export const HIGH_LOW_ROUND_TTL_SECONDS = 1800; // 30 分鐘
/** 單一動作鎖的存活時間：只需覆蓋一次請求處理時間 */
const LOCK_TTL_MS = 5000;

export function roundKey(userId: string): string {
  return `${HIGH_LOW_ROUND_KEY_PREFIX}${userId}`;
}

function lockKey(userId: string): string {
  return `${roundKey(userId)}:lock`;
}

function newRoundId(): string {
  return `HL${Date.now().toString(36)}-${rngToken(6)}`;
}

function parseRoundState(raw: string): HighLowRoundState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const s = data as Partial<HighLowRoundState>;
  if (
    typeof s.roundId !== 'string' ||
    (s.state !== 'GUESSING' && s.state !== 'RESULT') ||
    typeof s.betAmount !== 'number' ||
    typeof s.pot !== 'number' ||
    typeof s.streak !== 'number' ||
    typeof s.baseCard !== 'object' ||
    s.baseCard === null ||
    !Array.isArray(s.deck) ||
    typeof s.serverSeedHash !== 'string'
  ) {
    return null;
  }
  return s as HighLowRoundState;
}

export interface HighLowLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface HighLowServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  log?: HighLowLog;
  /** 測試注入：決定性 rng 驅動洗牌（預設 csprng rngInt） */
  rng?: RngFn;
  /** 測試注入：覆寫 round-lock（預設用 deps.redis 建立） */
  roundLock?: RoundLock;
}

export function createHighLowService(deps: HighLowServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: HighLowLog = deps.log ?? { warn: () => {} };
  const lock = deps.roundLock ?? createRoundLock(redis);

  async function getState(userId: string): Promise<HighLowRoundState | null> {
    const raw = await redis.get(roundKey(userId));
    return raw === null ? null : parseRoundState(raw);
  }

  async function saveState(userId: string, state: HighLowRoundState): Promise<void> {
    await redis.set(roundKey(userId), JSON.stringify(state), 'EX', HIGH_LOW_ROUND_TTL_SECONDS);
  }

  async function clearState(userId: string): Promise<void> {
    await redis.del(roundKey(userId));
  }

  /** lose / win-max-streak / cash-out 共用的最終結算（同一交易：更新 BetRecord + 條件入帳） */
  async function finalizeRound(
    userId: string,
    betRecordId: string,
    payout: number,
    detailPatch: Record<string, unknown>,
  ): Promise<bigint> {
    return prisma.$transaction(async (tx) => {
      let newBalance: bigint;
      if (payout > 0) {
        const credit = await wallet.credit(userId, BigInt(payout), 'PAYOUT', {
          tx,
          refId: betRecordId,
        });
        newBalance = credit.balance;
      } else {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
        newBalance = user.balance;
      }
      const existing = await tx.betRecord.findUniqueOrThrow({ where: { id: betRecordId } });
      const detail = existing.detail as Record<string, unknown>;
      await tx.betRecord.update({
        where: { id: betRecordId },
        data: {
          payout: BigInt(payout),
          detail: { ...detail, ...detailPatch } as Prisma.InputJsonValue,
        },
      });
      return newBalance;
    });
  }

  return {
    /** POST /api/high-low/deal（HMAC）：扣注額、開基準牌、存 round 狀態 */
    async deal(userId: string, betAmount: number): Promise<DealResult> {
      if (
        !Number.isSafeInteger(betAmount) ||
        betAmount < HIGH_LOW_MIN_BET ||
        betAmount > HIGH_LOW_MAX_BET
      ) {
        throw new ValidationError(`注額須為 ${HIGH_LOW_MIN_BET}~${HIGH_LOW_MAX_BET} 之間的整數`);
      }

      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const existing = await getState(userId);
        if (existing !== null) {
          throw new ConflictError('已有進行中的回合，請先完成或收手');
        }

        const deck = ensureDeckSize([], deps.rng);
        const baseCard = deck.shift();
        if (baseCard === undefined) throw new Error('high-low: 新牌堆不應為空');
        const roundId = newRoundId();
        const serverSeedHash = createHash('sha256').update(rngBytes(32)).digest('hex');

        await prisma.$transaction(async (tx) => {
          const record = await tx.betRecord.create({
            data: {
              userId,
              gameType: 'HIGH_LOW',
              amount: BigInt(betAmount),
              payout: 0n,
              roundId,
              serverSeedHash,
              detail: {
                status: 'OPEN',
                betAmount,
                pot: betAmount,
                streak: 0,
              } as Prisma.InputJsonValue,
            },
          });
          await wallet.debit(userId, BigInt(betAmount), 'BET', { tx, refId: record.id });
        });

        const state: HighLowRoundState = {
          roundId,
          state: 'GUESSING',
          betAmount,
          pot: betAmount,
          streak: 0,
          baseCard,
          pendingNextCard: null,
          deck,
          serverSeedHash,
        };
        await saveState(userId, state);

        return { roundId, baseCard, pot: betAmount };
      });
    },

    /** POST /api/high-low/guess（JWT 即可，不帶新注額） */
    async guess(userId: string, roundId: string, guessHigh: boolean): Promise<GuessResult> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }
        if (state.state !== 'GUESSING') {
          throw new ConflictError('目前不是猜測階段（請先選擇收手或繼續）');
        }
        if (!isLegalGuess(state.baseCard, guessHigh)) {
          throw new ValidationError('基準牌已是極值，不可往該方向猜測');
        }

        const deck = ensureDeckSize(state.deck, deps.rng);
        const nextCard = deck.shift();
        if (nextCard === undefined) throw new Error('high-low: 牌堆不應為空');
        const comparison = compareGuess(state.baseCard, nextCard, guessHigh);

        if (comparison === 'PUSH') {
          await saveState(userId, { ...state, baseCard: nextCard, deck });
          return {
            outcome: 'PUSH',
            revealedCard: nextCard,
            pot: state.pot,
            streak: state.streak,
            newBalance: null,
            payout: 0,
          };
        }

        if (comparison === 'WRONG') {
          const betRecord = await findOpenBetRecord(prisma, userId, roundId, log);
          const newBalance = await finalizeRound(userId, betRecord.id, 0, {
            status: 'SETTLED',
            outcome: 'LOSE',
            finalStreak: state.streak,
          });
          await clearState(userId);
          return {
            outcome: 'LOSE',
            revealedCard: nextCard,
            pot: 0,
            streak: state.streak,
            newBalance,
            payout: 0,
          };
        }

        // CORRECT
        const newStreak = state.streak + 1;
        const newPot = state.pot * 2;
        if (newStreak >= HIGH_LOW_MAX_STREAK) {
          const betRecord = await findOpenBetRecord(prisma, userId, roundId, log);
          const newBalance = await finalizeRound(userId, betRecord.id, newPot, {
            status: 'SETTLED',
            outcome: 'WIN_MAX_STREAK',
            finalStreak: newStreak,
          });
          await clearState(userId);
          return {
            outcome: 'WIN_MAX_STREAK',
            revealedCard: nextCard,
            pot: newPot,
            streak: newStreak,
            newBalance,
            payout: newPot,
          };
        }

        await saveState(userId, {
          ...state,
          state: 'RESULT',
          pot: newPot,
          streak: newStreak,
          pendingNextCard: nextCard,
          deck,
        });
        return {
          outcome: 'WIN_CONTINUE',
          revealedCard: nextCard,
          pot: newPot,
          streak: newStreak,
          newBalance: null,
          payout: 0,
        };
      });
    },

    /** POST /api/high-low/continue（JWT）：RESULT → GUESSING，採用剛翻出的牌作新基準牌 */
    async continueRound(userId: string, roundId: string): Promise<ContinueResult> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }
        if (state.state !== 'RESULT' || state.pendingNextCard === null) {
          throw new ConflictError('目前沒有可繼續的回合');
        }

        const baseCard = state.pendingNextCard;
        await saveState(userId, {
          ...state,
          state: 'GUESSING',
          baseCard,
          pendingNextCard: null,
        });
        return { baseCard, pot: state.pot, streak: state.streak };
      });
    },

    /** POST /api/high-low/cash-out（JWT，派彩金額是伺服器存的目前彩池，不需要 HMAC） */
    async cashOut(userId: string, roundId: string): Promise<CashOutResult> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }
        if (state.state !== 'RESULT') {
          throw new ConflictError('目前不是可收手的階段');
        }

        const betRecord = await findOpenBetRecord(prisma, userId, roundId, log);
        const newBalance = await finalizeRound(userId, betRecord.id, state.pot, {
          status: 'SETTLED',
          outcome: 'CASH_OUT',
          finalStreak: state.streak,
        });
        await clearState(userId);
        return { payout: state.pot, newBalance };
      });
    },

    /**
     * 孤兒回合清理（BullMQ job 呼叫，見 jobs/abandoned-round.job.ts）：
     * 卡在 GUESSING → 沒收彩池；卡在 RESULT → 強制收手。絕不是退款（見檔頭說明）。
     * 跟玩家自己呼叫的動作共用同一把 round-lock，不會跟即時請求互踩；如果回合
     * 在搶到鎖之前就已經被玩家自己結算掉了（state===null），視為無事可做。
     */
    async resolveAbandoned(userId: string): Promise<{ resolved: boolean; outcome?: string }> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null) return { resolved: false };

        const betRecord = await findOpenBetRecord(prisma, userId, state.roundId, log);
        if (state.state === 'GUESSING') {
          await finalizeRound(userId, betRecord.id, 0, {
            status: 'FORFEITED',
            outcome: 'ABANDONED_FORFEITED',
            finalStreak: state.streak,
          });
          await clearState(userId);
          return { resolved: true, outcome: 'FORFEITED' };
        }

        await finalizeRound(userId, betRecord.id, state.pot, {
          status: 'AUTO_SETTLED',
          outcome: 'ABANDONED_AUTO_CASH_OUT',
          finalStreak: state.streak,
        });
        await clearState(userId);
        return { resolved: true, outcome: 'AUTO_CASH_OUT' };
      });
    },
  };
}

/** OPEN 狀態的 BetRecord 是 deal() 建立的那一筆，用 roundId 找回（避免每個動作都要傳 betRecordId） */
async function findOpenBetRecord(
  prisma: PrismaClient,
  userId: string,
  roundId: string,
  log: HighLowLog,
): Promise<{ id: string }> {
  const record = await prisma.betRecord.findFirst({
    where: { userId, roundId, gameType: 'HIGH_LOW' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (record === null) {
    // Redis 說回合還在進行，DB 卻找不到對應紀錄——理論上不該發生，記警告供事後稽核
    log.warn({ userId, roundId }, 'high-low: Redis 回合存在但 BetRecord 找不到，資料不一致');
    throw new NotFoundError('找不到對應的下注紀錄');
  }
  return record;
}

export type HighLowService = ReturnType<typeof createHighLowService>;
