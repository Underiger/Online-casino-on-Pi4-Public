/**
 * Blackjack 服務單元測試：deal/hit/stand/double 全流程 + round-lock 併發保護。
 *
 * 用直接寫入 Redis 已知回合狀態的方式控制手牌（同 dragon-gate/high-low 的作法），
 * 不依賴猜中洗牌演算法的具體輸出。
 */
import { describe, expect, it } from 'vitest';
import {
  createBlackjackService,
  roundKey,
  type BlackjackService,
} from '../../src/modules/blackjack/blackjack.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';
import type { Card } from '../../src/shared/cards.js';
import type { BlackjackRoundState } from '../../src/modules/blackjack/blackjack.types.js';

const ALICE = 'user_alice';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

function setup(balance = 1_000n) {
  const db = createFakeDb({ users: [{ id: ALICE, balance }] });
  const redis = createFakeRedis();
  const service: BlackjackService = createBlackjackService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
    log: { warn: () => {} },
  });
  return { db, redis, service };
}

/** 直接寫入已知回合狀態，跳過 deal() 的洗牌；同時補一筆對應 OPEN 的 BetRecord */
async function seedRound(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<BlackjackRoundState> = {},
): Promise<BlackjackRoundState> {
  const state: BlackjackRoundState = {
    roundId: 'BJ-test-round',
    state: 'PLAYER_TURN',
    betAmount: 100,
    doubled: false,
    playerCards: [card(10), card(6)], // 16，未爆未天生 BJ
    dealerCards: [card(10), card(7)], // 17，S17 不補牌
    deck: [card(2)],
    serverSeedHash: 'a'.repeat(64),
    ...overrides,
  };
  await ctx.redis.redis.set(roundKey(ALICE), JSON.stringify(state));
  await ctx.db.prisma.betRecord.create({
    data: {
      userId: ALICE,
      gameType: 'BLACKJACK',
      amount: BigInt(state.betAmount),
      payout: 0n,
      roundId: state.roundId,
      serverSeedHash: state.serverSeedHash,
      detail: { status: 'OPEN', betAmount: state.betAmount, playerCards: state.playerCards, dealerCards: state.dealerCards },
    },
  });
  return state;
}

describe('deal', () => {
  it('一般發牌（非天生 BJ）：扣注額、回 PLAYER_TURN 視角（底牌隱藏）', async () => {
    const ctx = setup();
    const result = await ctx.service.deal(ALICE, 100);

    expect(result.settled).toBe(false);
    if (result.settled) throw new Error('unreachable');
    expect(result.playerCards).toHaveLength(2);
    expect(result.dealerUpCard).toBeDefined();
    expect(ctx.db.users[0]?.balance).toBe(900n);
  });

  it('已有進行中回合時再次 deal → ConflictError，不重複扣款', async () => {
    const ctx = setup();
    await ctx.service.deal(ALICE, 100);
    await expect(ctx.service.deal(ALICE, 100)).rejects.toThrow(ConflictError);
    expect(ctx.db.users[0]?.balance).toBe(900n);
  });

  it('注額超出範圍 → ValidationError', async () => {
    const ctx = setup();
    await expect(ctx.service.deal(ALICE, 5)).rejects.toThrow(ValidationError);
  });
});

describe('hit', () => {
  it('補牌後仍 <21 且未爆：維持 PLAYER_TURN，扣款不變、不入帳', async () => {
    const ctx = setup();
    await seedRound(ctx, { playerCards: [card(5), card(4)], deck: [card(3)] }); // 9 -> 12
    const result = await ctx.service.hit(ALICE, 'BJ-test-round');

    expect(result.settled).toBe(false);
    if (result.settled) throw new Error('unreachable');
    expect(result.playerCards).toHaveLength(3);
    expect(ctx.db.users[0]?.balance).toBe(1_000n); // 本測試未先扣款，純驗證沒有額外入帳
  });

  it('補牌後爆牌：直接結算為 BUST，不補莊家牌、清空回合', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(10), card(9)], // 19
      deck: [card(5)], // 19+5=24 爆牌
      dealerCards: [card(10), card(2)], // 12（若有補牌會變化，用來驗證「沒有補」）
    });
    const result = await ctx.service.hit(ALICE, 'BJ-test-round');

    expect(result.settled).toBe(true);
    if (!result.settled) throw new Error('unreachable');
    expect(result.resultKey).toBe('BUST');
    expect(result.payout).toBe(0);
    expect(result.dealerCards).toEqual([card(10), card(2)]); // 莊家牌沒有被補
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
  });

  it('補牌剛好 21 點：自動停牌進莊家流程並結算（不是天生 BJ，仍照點數比較）', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(10), card(8)], // 18
      deck: [card(3)], // 18+3=21（三張湊成的 21，非天生 BJ，不算 isBlackjack）
      dealerCards: [card(10), card(9)], // 19，S17 停牌，不補牌
    });
    const result = await ctx.service.hit(ALICE, 'BJ-test-round');

    expect(result.settled).toBe(true);
    if (!result.settled) throw new Error('unreachable');
    expect(result.playerCards).toHaveLength(3);
    expect(result.resultKey).toBe('WIN'); // 21 > 莊家 19，且非天生 BJ 只算 1:1 不算 3:2
    expect(result.payout).toBe(200);
  });

  it('roundId 不符 → NotFoundError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await expect(ctx.service.hit(ALICE, 'wrong-id')).rejects.toThrow(NotFoundError);
  });

  it('鎖被佔用時（模擬併發請求）→ OptimisticLockError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await ctx.redis.redis.set(`${roundKey(ALICE)}:lock`, 'someone-elses-token');
    await expect(ctx.service.hit(ALICE, 'BJ-test-round')).rejects.toThrow(OptimisticLockError);
  });
});

describe('stand', () => {
  it('停牌後莊家依規則補牌並結算（莊家 <17 會連續補到 >=17 為止）', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(10), card(9)], // 19
      dealerCards: [card(10), card(2)], // 12，必須補
      deck: [card(4), card(2)], // 12+4=16(<17,補) +2=18(>=17,停) → 莊家最終 18
    });
    const result = await ctx.service.stand(ALICE, 'BJ-test-round');

    expect(result.dealerCards).toHaveLength(4);
    expect(result.resultKey).toBe('WIN'); // 玩家 19 > 莊家 18
    expect(result.payout).toBe(200);
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
  });

  it('莊家已 >=17 不補牌直接結算', async () => {
    const ctx = setup();
    await seedRound(ctx); // 預設玩家16 / 莊家17
    const result = await ctx.service.stand(ALICE, 'BJ-test-round');
    expect(result.dealerCards).toHaveLength(2);
    expect(result.resultKey).toBe('LOSE'); // 16 < 17
  });

  it('roundId 不符 → NotFoundError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await expect(ctx.service.stand(ALICE, 'wrong-id')).rejects.toThrow(NotFoundError);
  });
});

describe('double', () => {
  it('前兩張才能加倍：再扣一次注額、補一張、強制停牌', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(5), card(4)], // 9（前兩張）
      dealerCards: [card(10), card(9)], // 19，S17 停牌
      deck: [card(10)], // 9+10=19
    });
    const result = await ctx.service.double(ALICE, 'BJ-test-round');

    expect(result.settled).toBe(true);
    if (!result.settled) throw new Error('unreachable');
    expect(result.betAmount).toBe(200); // 注額翻倍
    expect(result.resultKey).toBe('PUSH'); // 19 vs 19
    expect(result.payout).toBe(200); // push 退回的是翻倍後的注額
    // seedRound 跳過了 deal() 的首次扣款，本測試只驗證 double 自己扣的第二注 + push 入帳：
    // 1000（起始）− 100（double 扣的第二注，用原始注額）＋ 200（push 退回翻倍後注額）
    expect(ctx.db.users[0]?.balance).toBe(1_100n);
  });

  it('手牌已超過兩張時不可加倍 → ConflictError', async () => {
    const ctx = setup();
    await seedRound(ctx, { playerCards: [card(5), card(4), card(3)] });
    await expect(ctx.service.double(ALICE, 'BJ-test-round')).rejects.toThrow(ConflictError);
  });

  it('已經加倍過不可再加倍 → ConflictError', async () => {
    const ctx = setup();
    await seedRound(ctx, { doubled: true, playerCards: [card(5), card(4)] });
    await expect(ctx.service.double(ALICE, 'BJ-test-round')).rejects.toThrow(ConflictError);
  });

  it('餘額不足支付第二注 → InsufficientBalanceError，直接拒絕不改變任何狀態', async () => {
    const ctx = setup(50n); // 不夠付第二個 100
    await seedRound(ctx, { playerCards: [card(5), card(4)] });
    await expect(ctx.service.double(ALICE, 'BJ-test-round')).rejects.toThrow(
      InsufficientBalanceError,
    );
    // 回合狀態應該還在（沒有被部分修改）
    expect(await ctx.redis.redis.get(roundKey(ALICE))).not.toBeNull();
  });

  it('加倍補牌後爆牌：以雙倍注額結算為 BUST', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(10), card(9)], // 19
      deck: [card(5)], // 19+5=24 爆
    });
    const result = await ctx.service.double(ALICE, 'BJ-test-round');
    expect(result.settled).toBe(true);
    if (!result.settled) throw new Error('unreachable');
    expect(result.resultKey).toBe('BUST');
    expect(result.betAmount).toBe(200);
    expect(result.payout).toBe(0);
  });
});

describe('resolveAbandoned（孤兒回合清理，BullMQ job 呼叫）', () => {
  it('卡在 PLAYER_TURN：強制視為停牌（Auto Stand），照正常莊家補牌流程結算，絕不是退款', async () => {
    const ctx = setup();
    await seedRound(ctx, {
      playerCards: [card(10), card(9)], // 19
      dealerCards: [card(10), card(2)], // 12，停牌後必須補
      deck: [card(4), card(2)], // 12+4=16(<17,補)+2=18(>=17,停) → 莊家 18
    });
    const result = await ctx.service.resolveAbandoned(ALICE);

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe('WIN'); // 玩家 19 > 莊家 18
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
    expect(ctx.db.txRecords.every((t) => t.type !== 'REFUND')).toBe(true);
    expect(ctx.db.txRecords.some((t) => t.type === 'PAYOUT')).toBe(true); // 是入帳，不是退款
    expect(ctx.db.betRecords[0]?.detail).toMatchObject({ status: 'SETTLED', outcome: 'WIN' });
  });

  it('卡在 PLAYER_TURN 且停牌後輸了：結算為輸，不入帳、也不是退款', async () => {
    const ctx = setup(); // 預設玩家16 / 莊家17（S17 不補）→ 玩家輸
    await seedRound(ctx);
    const result = await ctx.service.resolveAbandoned(ALICE);

    expect(result.resolved).toBe(true);
    expect(result.outcome).toBe('LOSE');
    expect(ctx.db.users[0]?.balance).toBe(1_000n); // 沒有入帳（seedRound 本就沒扣過款）
    expect(ctx.db.txRecords.some((t) => t.type === 'REFUND')).toBe(false);
  });

  it('回合早已被玩家自己結算（Redis 已無狀態）：resolved=false，不做任何事', async () => {
    const ctx = setup();
    const result = await ctx.service.resolveAbandoned(ALICE);
    expect(result.resolved).toBe(false);
  });

  it('與玩家即時請求共用同一把鎖：鎖被佔用時清理也會等價地拋出 OptimisticLockError', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await ctx.redis.redis.set(`${roundKey(ALICE)}:lock`, 'someone-elses-token');
    await expect(ctx.service.resolveAbandoned(ALICE)).rejects.toThrow(OptimisticLockError);
  });
});
