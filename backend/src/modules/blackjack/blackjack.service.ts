/**
 * Blackjack 服務（規則港自 pokergame/games/blackjack.py，見 payout.ts 檔頭）。
 *
 * 四個動作（deal/hit/stand/double）都透過同一把 round-lock（security/round-lock.ts）
 * 序列化——理由與 high-low.service.ts 檔頭說明完全相同：這個回合的 Redis 狀態會被
 * 多種不同動作讀-改-寫，任何一個動作若不搶鎖都可能跟另一個併發請求互踩。
 *
 * 沒有獨立的 DEALER_TURN 狀態：莊家補牌迴圈（payout.ts resolveDealerTurn）在伺服器
 * 內一次跑完並直接結算，不需要在多個請求之間暫停——這點跟 High-Low 不同（High-Low
 * 「猜對後選收手或繼續」是玩家決策，必須暫停；莊家補牌純粹是規則，沒有決策可言）。
 *
 * 孤兒回合結算規則（TTL 逾時清理 job 共用，見 jobs/abandoned-round.job.ts）：
 *   卡在 PLAYER_TURN（已發牌，尚未 hit/stand/double）→ 強制視為停牌（Auto Stand），
 *   照正常莊家補牌流程跑完 settle()。「停牌」是玩家隨時可以零成本選的選項，逾時
 *   等同系統幫他按了停牌，結果分佈跟他自己按完全一樣，沒有套利空間，絕不是退款。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { BLACKJACK_MAX_BET, BLACKJACK_MIN_BET, BLACKJACK_NUM_DECKS } from '../../config/constants.js';
import { rngBytes, rngToken } from '../../security/csprng.js';
import { createRoundLock, type RoundLock } from '../../security/round-lock.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { freshShuffledDeck, type Card, type RngFn } from '../../shared/cards.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { handValue, isBlackjack, isBust, resolveDealerTurn, settle } from './payout.js';
import type {
  ActionResult,
  BlackjackRoundState,
  DealResult,
  SettledView,
} from './blackjack.types.js';

export const BLACKJACK_ROUND_KEY_PREFIX = 'blackjack:round:';
export const BLACKJACK_ROUND_TTL_SECONDS = 1800; // 30 分鐘，比孤兒回合 job 的不活躍門檻寬裕
const LOCK_TTL_MS = 5000;

export function roundKey(userId: string): string {
  return `${BLACKJACK_ROUND_KEY_PREFIX}${userId}`;
}

function lockKey(userId: string): string {
  return `${roundKey(userId)}:lock`;
}

function newRoundId(): string {
  return `BJ${Date.now().toString(36)}-${rngToken(6)}`;
}

function parseRoundState(raw: string): BlackjackRoundState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const s = data as Partial<BlackjackRoundState>;
  if (
    typeof s.roundId !== 'string' ||
    s.state !== 'PLAYER_TURN' ||
    typeof s.betAmount !== 'number' ||
    typeof s.doubled !== 'boolean' ||
    !Array.isArray(s.playerCards) ||
    !Array.isArray(s.dealerCards) ||
    !Array.isArray(s.deck) ||
    typeof s.serverSeedHash !== 'string'
  ) {
    return null;
  }
  return s as BlackjackRoundState;
}

export interface BlackjackLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface BlackjackServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  log?: BlackjackLog;
  /** 測試注入：決定性 rng 驅動洗牌（預設 csprng rngInt） */
  rng?: RngFn;
  /** 測試注入：覆寫 round-lock（預設用 deps.redis 建立） */
  roundLock?: RoundLock;
}

export function createBlackjackService(deps: BlackjackServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: BlackjackLog = deps.log ?? { warn: () => {} };
  const lock = deps.roundLock ?? createRoundLock(redis);

  async function getState(userId: string): Promise<BlackjackRoundState | null> {
    const raw = await redis.get(roundKey(userId));
    return raw === null ? null : parseRoundState(raw);
  }

  async function saveState(userId: string, state: BlackjackRoundState): Promise<void> {
    await redis.set(roundKey(userId), JSON.stringify(state), 'EX', BLACKJACK_ROUND_TTL_SECONDS);
  }

  async function clearState(userId: string): Promise<void> {
    await redis.del(roundKey(userId));
  }

  async function findOpenBetRecord(userId: string, roundId: string): Promise<{ id: string }> {
    const record = await prisma.betRecord.findFirst({
      where: { userId, roundId, gameType: 'BLACKJACK' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (record === null) {
      log.warn({ userId, roundId }, 'blackjack: Redis 回合存在但 BetRecord 找不到，資料不一致');
      throw new NotFoundError('找不到對應的下注紀錄');
    }
    return record;
  }

  /** settle 結果 → 結算（更新 BetRecord + 條件入帳，同一交易） */
  async function finalizeAndSettle(
    userId: string,
    betRecordId: string,
    playerCards: Card[],
    dealerCards: Card[],
    betAmount: number,
  ): Promise<{ resultKey: string; payout: number; newBalance: bigint }> {
    const outcome = settle(playerCards, dealerCards, betAmount);
    const newBalance = await prisma.$transaction(async (tx) => {
      let balance: bigint;
      if (outcome.payoutTotal > 0) {
        const credit = await wallet.credit(userId, BigInt(outcome.payoutTotal), 'PAYOUT', {
          tx,
          refId: betRecordId,
        });
        balance = credit.balance;
      } else {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
        balance = user.balance;
      }
      const existing = await tx.betRecord.findUniqueOrThrow({ where: { id: betRecordId } });
      const detail = existing.detail as Record<string, unknown>;
      await tx.betRecord.update({
        where: { id: betRecordId },
        data: {
          amount: BigInt(betAmount), // 加倍會改變最終注額，落帳以實際下注金額為準
          payout: BigInt(outcome.payoutTotal),
          detail: {
            ...detail,
            status: 'SETTLED',
            outcome: outcome.resultKey,
            playerCards,
            dealerCards,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return balance;
    });
    return { resultKey: outcome.resultKey, payout: outcome.payoutTotal, newBalance };
  }

  /**
   * 停牌（或加倍後強制停牌）：莊家補牌跑完 → 結算 → 清空回合。
   * 玩家已爆牌時不補牌（settle 不會看莊家牌，補了也不影響輸贏，但會多消耗牌堆、
   * 顯示出「不該存在」的莊家牌——pokergame 原版同樣是爆牌就直接結算，不進莊家回合）。
   */
  async function standAndSettle(
    userId: string,
    roundId: string,
    betRecordId: string,
    playerCards: Card[],
    dealerCards: Card[],
    deck: Card[],
    betAmount: number,
  ): Promise<SettledView> {
    const finalDealer = isBust(playerCards) ? dealerCards : resolveDealerTurn(dealerCards, deck).dealerCards;
    const { resultKey, payout, newBalance } = await finalizeAndSettle(
      userId,
      betRecordId,
      playerCards,
      finalDealer,
      betAmount,
    );
    await clearState(userId);
    return {
      settled: true,
      roundId,
      resultKey: resultKey as SettledView['resultKey'],
      playerCards,
      dealerCards: finalDealer,
      betAmount,
      payout,
      newBalance,
    };
  }

  return {
    /** POST /api/blackjack/deal（HMAC）：扣注額、發 4 張，天生 BJ 直接結算 */
    async deal(userId: string, betAmount: number): Promise<DealResult> {
      if (
        !Number.isSafeInteger(betAmount) ||
        betAmount < BLACKJACK_MIN_BET ||
        betAmount > BLACKJACK_MAX_BET
      ) {
        throw new ValidationError(`注額須為 ${BLACKJACK_MIN_BET}~${BLACKJACK_MAX_BET} 之間的整數`);
      }

      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const existing = await getState(userId);
        if (existing !== null) {
          throw new ConflictError('已有進行中的回合，請先完成');
        }

        const deck = freshShuffledDeck(BLACKJACK_NUM_DECKS, deps.rng);
        // 標準發牌順序：玩家-莊家-玩家-莊家（第二張莊家牌為底牌）
        const playerCards: Card[] = [];
        const dealerCards: Card[] = [];
        for (let i = 0; i < 2; i += 1) {
          const p = deck.shift();
          const d = deck.shift();
          if (p === undefined || d === undefined) throw new Error('blackjack: 新牌堆不應為空');
          playerCards.push(p);
          dealerCards.push(d);
        }
        const roundId = newRoundId();
        const serverSeedHash = createHash('sha256').update(rngBytes(32)).digest('hex');

        const betRecordId = await prisma.$transaction(async (tx) => {
          const record = await tx.betRecord.create({
            data: {
              userId,
              gameType: 'BLACKJACK',
              amount: BigInt(betAmount),
              payout: 0n,
              roundId,
              serverSeedHash,
              detail: { status: 'OPEN', betAmount, playerCards, dealerCards } as unknown as Prisma.InputJsonValue,
            },
          });
          await wallet.debit(userId, BigInt(betAmount), 'BET', { tx, refId: record.id });
          return record.id;
        });

        if (isBlackjack(playerCards)) {
          // 玩家天生 BJ：莊家不補牌，只看是否雙 BJ（settle 本身會處理），直接結算
          return standAndSettle(userId, roundId, betRecordId, playerCards, dealerCards, deck, betAmount);
        }

        const state: BlackjackRoundState = {
          roundId,
          state: 'PLAYER_TURN',
          betAmount,
          doubled: false,
          playerCards,
          dealerCards,
          deck,
          serverSeedHash,
        };
        await saveState(userId, state);
        return {
          settled: false,
          roundId,
          playerCards,
          dealerUpCard: dealerCards[0] as Card,
          betAmount,
          doubled: false,
        };
      });
    },

    /** POST /api/blackjack/hit（JWT）：補牌，爆牌或湊到 21 直接結算 */
    async hit(userId: string, roundId: string): Promise<ActionResult> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }

        const deck = [...state.deck];
        const nextCard = deck.shift();
        if (nextCard === undefined) throw new Error('blackjack: 牌堆不應為空');
        const playerCards = [...state.playerCards, nextCard];

        if (isBust(playerCards)) {
          const betRecordId = (await findOpenBetRecord(userId, roundId)).id;
          const result = await standAndSettle(
            userId,
            roundId,
            betRecordId,
            playerCards,
            state.dealerCards,
            deck,
            state.betAmount,
          );
          return result;
        }

        const [value] = handValue(playerCards);
        if (value === 21) {
          // 21 點自動停牌（防玩家手滑要牌爆掉），同 pokergame _hit() 邏輯
          const betRecordId = (await findOpenBetRecord(userId, roundId)).id;
          return standAndSettle(
            userId,
            roundId,
            betRecordId,
            playerCards,
            state.dealerCards,
            deck,
            state.betAmount,
          );
        }

        await saveState(userId, { ...state, playerCards, deck });
        return {
          settled: false,
          roundId,
          playerCards,
          dealerUpCard: state.dealerCards[0] as Card,
          betAmount: state.betAmount,
          doubled: state.doubled,
        };
      });
    },

    /** POST /api/blackjack/stand（JWT）：進莊家補牌流程並結算 */
    async stand(userId: string, roundId: string): Promise<SettledView> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }
        const betRecordId = (await findOpenBetRecord(userId, roundId)).id;
        return standAndSettle(
          userId,
          roundId,
          betRecordId,
          state.playerCards,
          state.dealerCards,
          state.deck,
          state.betAmount,
        );
      });
    },

    /** POST /api/blackjack/double（JWT，加注金額＝伺服器存的原始注額，不需要 HMAC）：
     * 限手牌數=2，再扣一次注額，補一張，強制停牌 */
    async double(userId: string, roundId: string): Promise<ActionResult> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null || state.roundId !== roundId) {
          throw new NotFoundError('回合不存在或已結算，請重新下注');
        }
        if (state.playerCards.length !== 2 || state.doubled) {
          throw new ConflictError('目前不可加倍（僅限前兩張、且只能加倍一次）');
        }

        const betRecordId = (await findOpenBetRecord(userId, roundId)).id;
        // 主動的加倍動作：餘額不足就直接拒絕（不像踩柱那種被動懲罰需要降級），
        // 這裡刻意不帶 tx，失敗時前面什麼都還沒變動，不需要回滾任何東西。
        await wallet.debit(userId, BigInt(state.betAmount), 'BET', { refId: betRecordId });

        const newBetAmount = state.betAmount * 2;
        const deck = [...state.deck];
        const nextCard = deck.shift();
        if (nextCard === undefined) throw new Error('blackjack: 牌堆不應為空');
        const playerCards = [...state.playerCards, nextCard];

        // 加倍永遠強制停牌（不管爆不爆）：standAndSettle 內部已處理「爆牌不補莊家牌」
        return standAndSettle(userId, roundId, betRecordId, playerCards, state.dealerCards, deck, newBetAmount);
      });
    },

    /**
     * 孤兒回合清理（BullMQ job 呼叫，見 jobs/abandoned-round.job.ts）：
     * 卡在 PLAYER_TURN → 強制視為停牌（Auto Stand），照正常莊家補牌流程跑完 settle()。
     * 跟玩家自己呼叫的動作共用同一把 round-lock，不會跟即時請求互踩；如果回合在
     * 搶到鎖之前就已經被玩家自己結算掉了（state===null），視為無事可做。
     */
    async resolveAbandoned(userId: string): Promise<{ resolved: boolean; outcome?: string }> {
      return lock.withLock(lockKey(userId), LOCK_TTL_MS, async () => {
        const state = await getState(userId);
        if (state === null) return { resolved: false };

        const betRecordId = (await findOpenBetRecord(userId, state.roundId)).id;
        const result = await standAndSettle(
          userId,
          state.roundId,
          betRecordId,
          state.playerCards,
          state.dealerCards,
          state.deck,
          state.betAmount,
        );
        return { resolved: true, outcome: result.resultKey };
      });
    },
  };
}

export type BlackjackService = ReturnType<typeof createBlackjackService>;
