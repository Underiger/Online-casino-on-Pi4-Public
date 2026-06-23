/**
 * High-Low 服務單元測試：deal/guess/continue/cash-out 全狀態機 + round-lock 併發保護。
 *
 * 用直接寫入 Redis 已知回合狀態的方式控制猜測結果（同 dragon-gate.service.spec.ts
 * 的作法），不依賴猜中洗牌演算法的具體輸出。
 */
import { describe, expect, it } from 'vitest';
import {
  createHighLowService,
  roundKey,
  type HighLowService,
} from '../../src/modules/high-low/high-low.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';
import type { Card } from '../../src/shared/cards.js';
import type { HighLowRoundState } from '../../src/modules/high-low/high-low.types.js';

const ALICE = 'user_alice';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

/** ensureDeckSize 在 <10 張時會整副重洗，所以測試要控制「下一張牌」時必須墊夠張數 */
function deckWithNext(next: Card): Card[] {
  return [next, ...Array.from({ length: 11 }, () => card(2, 'CLUB'))];
}

function setup(balance = 1_000n) {
  const db = createFakeDb({ users: [{ id: ALICE, balance }] });
  const redis = createFakeRedis();
  const service: HighLowService = createHighLowService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
    log: { warn: () => {} },
  });
  return { db, redis, service };
}

/** 直接寫入已知回合狀態，跳過 deal() 的洗牌；同時補一筆對應 OPEN 的 BetRecord
 * （finalizeRound 會用 roundId 去資料庫找這筆，沒有的話會找不到） */
async function seedRound(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<HighLowRoundState> = {},
): Promise<HighLowRoundState> {
  const state: HighLowRoundState = {
    roundId: 'HL-test-round',
    state: 'GUESSING',
    betAmount: 100,
    pot: 100,
    streak: 0,
    baseCard: card(7),
    pendingNextCard: null,
    deck: deckWithNext(card(9, 'HEART')), // 預設下一張比基準牌高 → CORRECT
    serverSeedHash: 'a'.repeat(64),
    ...overrides,
  };
  await ctx.redis.redis.set(roundKey(ALICE), JSON.stringify(state));
  await ctx.db.prisma.betRecord.create({
    data: {
      userId: ALICE,
      gameType: 'HIGH_LOW',
      amount: BigInt(state.betAmount),
      payout: 0n,
      roundId: state.roundId,
      serverSeedHash: state.serverSeedHash,
      detail: { status: 'OPEN', betAmount: state.betAmount, pot: state.pot, streak: state.streak },
    },
  });
  return state;
}

describe('deal', () => {
  it('扣注額、開基準牌、回傳 pot=注額，BetRecord 落帳為 OPEN', async () => {
    const ctx = setup();
    const result = await ctx.service.deal(ALICE, 100);

    expect(result.pot).toBe(100);
    expect(result.baseCard).toBeDefined();
    expect(ctx.db.users[0]?.balance).toBe(900n);
    expect(ctx.db.betRecords).toHaveLength(1);
    expect(ctx.db.betRecords[0]).toMatchObject({ amount: 100n, payout: 0n, roundId: result.roundId });
  });

  it('已有進行中回合時再次 deal → ConflictError，不重複扣款', async () => {
    const ctx = setup();
    await ctx.service.deal(ALICE, 100);
    await expect(ctx.service.deal(ALICE, 100)).rejects.toThrow(ConflictError);
    expect(ctx.db.users[0]?.balance).toBe(900n); // 只扣了一次
  });

  it('注額超出範圍 → ValidationError', async () => {
    const ctx = setup();
    await expect(ctx.service.deal(ALICE, 5)).rejects.toThrow(ValidationError);
  });
});

describe('guess', () => {
  it('基準牌是 A 時猜高 → ValidationError（伺服器端也擋，不只是前端）', async () => {
    const ctx = setup();
    await seedRound(ctx, { baseCard: card(14) });
    await expect(ctx.service.guess(ALICE, 'HL-test-round', true)).rejects.toThrow(ValidationError);
  });

  it('PUSH：同點數，彩池與連勝不變，回合維持 GUESSING', async () => {
    const ctx = setup();
    await seedRound(ctx, { deck: deckWithNext(card(7, 'HEART')) }); // 跟基準牌同點
    const result = await ctx.service.guess(ALICE, 'HL-test-round', true);

    expect(result.outcome).toBe('PUSH');
    expect(result.pot).toBe(100);
    expect(result.streak).toBe(0);

    const raw = await ctx.redis.redis.get(roundKey(ALICE));
    expect(JSON.parse(raw as string).state).toBe('GUESSING');
  });

  it('猜對（未達連勝上限）：彩池翻倍、進 RESULT 狀態，尚未入帳', async () => {
    const ctx = setup();
    await seedRound(ctx); // deck 預設下一張比基準高
    const result = await ctx.service.guess(ALICE, 'HL-test-round', true);

    expect(result.outcome).toBe('WIN_CONTINUE');
    expect(result.pot).toBe(200);
    expect(result.streak).toBe(1);
    expect(result.newBalance).toBeNull(); // 還沒入帳
    expect(ctx.db.users[0]?.balance).toBe(1_000n); // 餘額還沒變

    const raw = await ctx.redis.redis.get(roundKey(ALICE));
    expect(JSON.parse(raw as string).state).toBe('RESULT');
  });

  it('猜對且達連勝上限：強制收手結算，直接入帳並清空回合', async () => {
    const ctx = setup();
    await seedRound(ctx, { streak: 4 }); // 這次猜對就是第 5 連勝
    const result = await ctx.service.guess(ALICE, 'HL-test-round', true);

    expect(result.outcome).toBe('WIN_MAX_STREAK');
    expect(result.pot).toBe(200);
    expect(result.payout).toBe(200);
    expect(result.newBalance).toBe(1_200n); // seedRound 跳過 deal() 的扣款，這裡只驗證入帳：1000 + 200
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
  });

  it('猜錯：彩池歸零、回合結算為輸，不入帳', async () => {
    const ctx = setup();
    await seedRound(ctx, { deck: deckWithNext(card(3, 'HEART')) }); // 比基準牌低，猜高就猜錯
    const result = await ctx.service.guess(ALICE, 'HL-test-round', true);

    expect(result.outcome).toBe('LOSE');
    expect(result.pot).toBe(0);
    expect(result.newBalance).toBe(1_000n); // deal 時已扣的部分本測試未扣，這裡只驗證沒有再扣/入帳
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
    expect(ctx.db.betRecords[0]?.detail).toMatchObject({ outcome: 'LOSE' });
  });

  it('在 RESULT 狀態（剛贏一手，還沒選收手或繼續）呼叫 guess → ConflictError', async () => {
    const ctx = setup();
    await seedRound(ctx, { state: 'RESULT', pot: 200, streak: 1, pendingNextCard: card(9) });
    await expect(ctx.service.guess(ALICE, 'HL-test-round', true)).rejects.toThrow(ConflictError);
  });

  it('roundId 不符 → NotFoundError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await expect(ctx.service.guess(ALICE, 'wrong-id', true)).rejects.toThrow(NotFoundError);
  });

  it('鎖被佔用時（模擬併發請求）→ OptimisticLockError，不會卡住等待', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await ctx.redis.redis.set(`${roundKey(ALICE)}:lock`, 'someone-elses-token');
    await expect(ctx.service.guess(ALICE, 'HL-test-round', true)).rejects.toThrow(
      OptimisticLockError,
    );
  });
});

describe('continueRound', () => {
  it('RESULT → GUESSING，採用剛翻出的牌作新基準牌', async () => {
    const ctx = setup();
    await seedRound(ctx, { state: 'RESULT', pot: 200, streak: 1, pendingNextCard: card(9) });
    const result = await ctx.service.continueRound(ALICE, 'HL-test-round');

    expect(result.baseCard).toEqual(card(9));
    expect(result.pot).toBe(200);

    const raw = await ctx.redis.redis.get(roundKey(ALICE));
    const state = JSON.parse(raw as string);
    expect(state.state).toBe('GUESSING');
    expect(state.pendingNextCard).toBeNull();
  });

  it('在 GUESSING 狀態（沒有可繼續的贏局）呼叫 continue → ConflictError', async () => {
    const ctx = setup();
    await seedRound(ctx); // 預設 GUESSING
    await expect(ctx.service.continueRound(ALICE, 'HL-test-round')).rejects.toThrow(ConflictError);
  });
});

describe('cashOut', () => {
  it('RESULT 狀態收手：入帳目前彩池、清空回合', async () => {
    const ctx = setup();
    await seedRound(ctx, { state: 'RESULT', pot: 200, streak: 1, pendingNextCard: card(9) });
    const result = await ctx.service.cashOut(ALICE, 'HL-test-round');

    expect(result.payout).toBe(200);
    expect(result.newBalance).toBe(1_200n); // 1000 + 200（本測試未先扣注額，純驗證入帳）
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
  });

  it('GUESSING 狀態（還沒贏過一手）不可收手 → ConflictError（與原版規則一致）', async () => {
    const ctx = setup();
    await seedRound(ctx); // 預設 GUESSING
    await expect(ctx.service.cashOut(ALICE, 'HL-test-round')).rejects.toThrow(ConflictError);
  });
});

describe('resolveAbandoned（孤兒回合清理，BullMQ job 呼叫）', () => {
  it('卡在 GUESSING：沒收目前彩池（forfeit），絕不是退款原始注額', async () => {
    const ctx = setup();
    await seedRound(ctx, { pot: 400, streak: 2 }); // 已連勝兩次，pot 比原始注額(100)高很多
    const result = await ctx.service.resolveAbandoned(ALICE);

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe('FORFEITED');
    expect(ctx.db.users[0]?.balance).toBe(1_000n); // 完全沒有入帳（seedRound 本就沒扣過款）
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
    // 沒有任何一筆 BalanceTransaction 是 REFUND 類型——根本沒有產生任何交易紀錄
    expect(ctx.db.txRecords.some((t) => t.type === 'REFUND')).toBe(false);
    expect(ctx.db.betRecords[0]?.detail).toMatchObject({ status: 'FORFEITED' });
  });

  it('卡在 RESULT：強制視為收手，入帳目前彩池（等同玩家自己按收手）', async () => {
    const ctx = setup();
    await seedRound(ctx, { state: 'RESULT', pot: 400, streak: 2, pendingNextCard: card(9) });
    const result = await ctx.service.resolveAbandoned(ALICE);

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe('AUTO_CASH_OUT');
    expect(ctx.db.users[0]?.balance).toBe(1_400n); // 1000 + 400（彩池入帳）
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
    expect(ctx.db.txRecords.every((t) => t.type !== 'REFUND')).toBe(true);
    expect(ctx.db.txRecords.some((t) => t.type === 'PAYOUT')).toBe(true); // 是入帳，不是退款
  });

  it('回合早已被玩家自己結算（Redis 已無狀態）：resolved=false，不做任何事', async () => {
    const ctx = setup();
    const result = await ctx.service.resolveAbandoned(ALICE);
    expect(result.resolved).toBe(false);
    expect(ctx.db.users[0]?.balance).toBe(1_000n);
  });

  it('與玩家即時請求共用同一把鎖：鎖被佔用時清理也會等價地拋出 OptimisticLockError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await ctx.redis.redis.set(`${roundKey(ALICE)}:lock`, 'someone-elses-token');
    await expect(ctx.service.resolveAbandoned(ALICE)).rejects.toThrow(OptimisticLockError);
  });
});
