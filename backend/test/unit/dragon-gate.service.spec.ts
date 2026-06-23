/**
 * 射龍門服務單元測試。
 *
 * open() 只驗證結構正確（門牌/賠率由 payout.spec.ts 的純函式測試已詳盡覆蓋）；
 * bet() 用直接寫入 Redis 已知回合狀態的方式控制結果（WIN/DOOR_HIT/LOSE），
 * 不依賴猜中洗牌演算法的具體輸出，更穩定也更貼近「測試 service 的結算邏輯」本意。
 */
import { describe, expect, it } from 'vitest';
import {
  createDragonGateService,
  roundKey,
  type DragonGateService,
} from '../../src/modules/dragon-gate/dragon-gate.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { InsufficientBalanceError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';
import type { Card } from '../../src/shared/cards.js';
import type { DragonGateRoundState } from '../../src/modules/dragon-gate/dragon-gate.types.js';

const ALICE = 'user_alice';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

function setup(balance = 1_000n) {
  const db = createFakeDb({ users: [{ id: ALICE, balance }] });
  const redis = createFakeRedis();
  const service: DragonGateService = createDragonGateService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
    log: { warn: () => {} },
  });
  return { db, redis, service };
}

/** 直接寫入一筆已知回合狀態，跳過 open() 的洗牌，讓 bet() 測試可以精準控制結果 */
async function seedRound(
  redis: ReturnType<typeof createFakeRedis>,
  userId: string,
  overrides: Partial<DragonGateRoundState> = {},
): Promise<DragonGateRoundState> {
  const state: DragonGateRoundState = {
    roundId: 'DG-test-round',
    doors: [card(3), card(9)],
    gap: 5,
    oddsMode: 'TIER_11',
    multiplier: 1.6, // gap=5 的 TIER_11 倍率
    remainingDeck: [card(6, 'HEART')], // 預設第三張牌落在門內 → WIN
    serverSeedHash: 'a'.repeat(64),
    ...overrides,
  };
  await redis.redis.set(roundKey(userId), JSON.stringify(state));
  return state;
}

describe('open', () => {
  it('回傳合法門牌（gap>=1）與對應倍率，並寫入 Redis 回合狀態', async () => {
    const { redis, service } = setup();
    const result = await service.open(ALICE);

    expect(result.gap).toBeGreaterThanOrEqual(1);
    expect(result.doors).toHaveLength(2);
    expect(result.multiplier).toBeGreaterThan(0);
    expect(await redis.redis.get(roundKey(ALICE))).not.toBeNull();
  });
});

describe('bet', () => {
  it('WIN：介於兩門之間 → 入帳 bet*(1+multiplier)，BetRecord 正確落帳', async () => {
    const { db, redis, service } = setup();
    await seedRound(redis, ALICE);

    const outcome = await service.bet(ALICE, 'DG-test-round', 100);

    expect(outcome.outcome).toBe('WIN');
    expect(outcome.payout).toBe(260); // 100 * (1+1.6)
    expect(outcome.newBalance).toBe(1_160n); // 1000 - 100 + 260
    expect(outcome.extraLossApplied).toBe(false);
    expect(db.betRecords).toHaveLength(1);
    expect(db.betRecords[0]).toMatchObject({
      gameType: 'DRAGON_GATE',
      amount: 100n,
      payout: 260n,
      roundId: 'DG-test-round',
    });
  });

  it('LOSE：門外 → 只輸已扣的單注，不再額外扣款', async () => {
    const { redis, service } = setup();
    await seedRound(redis, ALICE, { remainingDeck: [card(2)] }); // 2 在門外（< 門3）

    const outcome = await service.bet(ALICE, 'DG-test-round', 100);

    expect(outcome.outcome).toBe('LOSE');
    expect(outcome.payout).toBe(0);
    expect(outcome.newBalance).toBe(900n); // 1000 - 100
  });

  it('DOOR_HIT：踩柱牌 → 再輸一注（總共輸 2 倍注額）', async () => {
    const { db, redis, service } = setup();
    await seedRound(redis, ALICE, { remainingDeck: [card(3, 'CLUB')] }); // 命中門牌 3

    const outcome = await service.bet(ALICE, 'DG-test-round', 100);

    expect(outcome.outcome).toBe('DOOR_HIT');
    expect(outcome.payout).toBe(0);
    expect(outcome.extraLossApplied).toBe(true);
    expect(outcome.newBalance).toBe(800n); // 1000 - 100（單注) - 100（踩柱再輸一注）
    expect(db.betRecords[0]?.detail).toMatchObject({ extraLossApplied: true });
  });

  it('DOOR_HIT 但餘額不足支付第二注時：降級為只輸單注，不拋錯、不卡住結算', async () => {
    const { service, redis } = setup(150n); // 第一注 100 扣完只剩 50，不夠付第二個 100
    await seedRound(redis, ALICE, { remainingDeck: [card(3, 'CLUB')] });

    const outcome = await service.bet(ALICE, 'DG-test-round', 100);

    expect(outcome.outcome).toBe('DOOR_HIT');
    expect(outcome.extraLossApplied).toBe(false); // 第二筆扣款失敗，降級
    expect(outcome.newBalance).toBe(50n); // 只扣了第一注
  });

  it('回合不存在（從未開門）→ NotFoundError', async () => {
    const { service } = setup();
    await expect(service.bet(ALICE, 'nope', 100)).rejects.toThrow(NotFoundError);
  });

  it('roundId 不符 → NotFoundError（且該次呼叫已消耗掉 Redis 狀態）', async () => {
    const { redis, service } = setup();
    await seedRound(redis, ALICE);

    await expect(service.bet(ALICE, 'wrong-round-id', 100)).rejects.toThrow(NotFoundError);
  });

  it('併發重複下注：第二次呼叫因狀態已被 GETDEL 取走而回 NotFoundError（防止重複結算）', async () => {
    const { redis, service } = setup();
    await seedRound(redis, ALICE);

    await service.bet(ALICE, 'DG-test-round', 100); // 第一次成功
    await expect(service.bet(ALICE, 'DG-test-round', 100)).rejects.toThrow(NotFoundError);
  });

  it('注額超出上下限 → ValidationError', async () => {
    const { redis, service } = setup();
    await seedRound(redis, ALICE);
    await expect(service.bet(ALICE, 'DG-test-round', 5)).rejects.toThrow(ValidationError);
  });

  it('餘額不足支付第一注 → InsufficientBalanceError，整筆回滾（無 BetRecord）', async () => {
    const { db, redis, service } = setup(50n);
    await seedRound(redis, ALICE);

    await expect(service.bet(ALICE, 'DG-test-round', 100)).rejects.toThrow(
      InsufficientBalanceError,
    );
    expect(db.betRecords).toHaveLength(0);
  });
});
