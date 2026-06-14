/**
 * Slot spin 服務單元測試（M11 DoD）。
 *
 * 決定性 rng 點位 ↔ 符號對照（基礎表 ×WEIGHT_PRECISION=100，總權重 10000；
 * 無 WEIGHT 護符 / 無幸運符號時三軸同表）：
 *   CHERRY 0–5699 | LEMON 5700–6499 | BELL 6500–7199 | BAR 7200–7799
 *   CLOVER 7800–8599 | LUCKY7 8600–9099 | DIAMOND 9100–9599 | WILD 9600–9999
 *
 * 覆蓋：中獎/未中獎全流程（落帳、pity、回應形狀）、注額驗證、餘額不足整筆回滾、
 * loadout 快取 hit/miss/損毀/Redis 故障、護符接線（PITY 加成 + charmsUsed）、
 * Jackpot 點數累加與 accumulate 呼叫、LOADOUT_COMPILE_FAILED、pity Redis 故障容錯。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  createSlotService,
  loadoutCacheKey,
  pityCounterKey,
  parseCachedLoadout,
  DAILY_LUCKY_SYMBOL_KEY,
  type SlotService,
} from '../../src/modules/slot/slot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  AppError,
  InsufficientBalanceError,
  ValidationError,
} from '../../src/shared/errors.js';
import {
  createFakeDb,
  createFakeRedis,
  makeRng,
  type FakeCharmRow,
} from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

/** 記錄呼叫的 fake jackpot service（M14：含觸發判定與派彩樁） */
function makeFakeJackpot(options: {
  trigger?: boolean;
  payoutResult?: { payout: bigint; poolBefore: bigint; remained: bigint; winnerBalance: bigint } | null;
  payoutThrows?: boolean;
} = {}) {
  const calls: number[] = [];
  const triggerCalls: number[] = [];
  const payoutCalls: string[] = [];
  return {
    calls,
    triggerCalls,
    payoutCalls,
    service: {
      accumulate: async (betAmount: number): Promise<number> => {
        calls.push(betAmount);
        return 0;
      },
      tryTriggerJackpot: (jackpotPoints: number): boolean => {
        triggerCalls.push(jackpotPoints);
        return options.trigger ?? false;
      },
      payout: async (userId: string) => {
        payoutCalls.push(userId);
        if (options.payoutThrows) throw new Error('payout exploded');
        return options.payoutResult ?? null;
      },
    },
  };
}

interface SetupOptions {
  balance?: bigint;
  jackpotPoints?: number;
  charmRows?: FakeCharmRow[];
  charmFindManyThrows?: boolean;
  rngPoints?: number[];
  jackpotOptions?: Parameters<typeof makeFakeJackpot>[0];
}

function setup(options: SetupOptions = {}) {
  const db = createFakeDb({
    users: [
      {
        id: ALICE,
        balance: options.balance ?? 5_000n,
        jackpotPoints: options.jackpotPoints ?? 0,
      },
    ],
    charmRows: options.charmRows ?? [],
    ...(options.charmFindManyThrows !== undefined
      ? { charmFindManyThrows: options.charmFindManyThrows }
      : {}),
  });
  const redis = createFakeRedis();
  const jackpot = makeFakeJackpot(options.jackpotOptions ?? {});
  const rng = makeRng(options.rngPoints ?? []);
  const errors: unknown[] = [];
  const service: SlotService = createSlotService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
    jackpot: jackpot.service,
    rng,
    log: { warn: () => {}, error: (obj) => errors.push(obj) },
  });
  return { db, redis, jackpot, rng, service, errors };
}

// ═════════════════ 主流程 ═════════════════

describe('spin 主流程', () => {
  it('CHERRY 三連中獎：扣款 + 賠付 + BetRecord + 雙 Tx 落帳 + pity 歸零', async () => {
    const { db, redis, jackpot, service } = setup({ rngPoints: [0, 0, 0] });
    await redis.redis.set(pityCounterKey(ALICE), '3'); // 進場前累積 3 次未中

    const outcome = await service.spin(ALICE, 10);

    // 回應形狀（docs/04_API_SPEC.md §3.4 SpinRes）
    expect(outcome.reels).toEqual(['CHERRY', 'CHERRY', 'CHERRY']);
    expect(outcome.payout).toBe(40); // 10 × 4
    expect(outcome.betAmount).toBe(10);
    expect(outcome.newBalance).toBe(5_030n); // 5000 − 10 + 40
    expect(outcome.pityActive).toBe(false); // 無 PITY 護符
    expect(outcome.pityCounter).toBe(0); // 中獎歸零
    expect(outcome.jackpotTriggered).toBe(false);
    expect(outcome.jackpotPoints).toBe(0);
    expect(outcome.luckySymbol).toBeNull();
    expect(outcome.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);

    // BetRecord
    expect(db.betRecords).toHaveLength(1);
    expect(db.betRecords[0]).toMatchObject({
      userId: ALICE,
      gameType: 'SLOT',
      amount: 10n,
      payout: 40n,
      serverSeedHash: outcome.serverSeedHash,
    });
    expect(db.betRecords[0]!.detail).toMatchObject({
      reels: ['CHERRY', 'CHERRY', 'CHERRY'],
      charmsUsed: [],
      pityActive: false,
      luckySymbol: null,
      lineKind: 'TRIPLE',
    });
    expect(outcome.betRecordId).toBe(db.betRecords[0]!.id);

    // BET + PAYOUT 兩筆 Tx，refId 皆指向 BetRecord
    expect(db.txRecords).toHaveLength(2);
    expect(db.txRecords[0]).toMatchObject({
      type: 'BET',
      delta: -10n,
      refId: outcome.betRecordId,
    });
    expect(db.txRecords[1]).toMatchObject({
      type: 'PAYOUT',
      delta: 40n,
      refId: outcome.betRecordId,
    });

    // pity 歸零（DEL）；jackpot 累積收到注額
    expect(await redis.redis.get(pityCounterKey(ALICE))).toBeNull();
    expect(jackpot.calls).toEqual([10]);
  });

  it('未中獎：無 PAYOUT Tx、pity INCR、payout=0', async () => {
    // CHERRY, LEMON, BELL → 無連線
    const { db, redis, service } = setup({ rngPoints: [0, 5_700, 6_500] });

    const outcome = await service.spin(ALICE, 50);

    expect(outcome.reels).toEqual(['CHERRY', 'LEMON', 'BELL']);
    expect(outcome.payout).toBe(0);
    expect(outcome.newBalance).toBe(4_950n);
    expect(outcome.pityCounter).toBe(1); // 0 → 1
    expect(db.txRecords).toHaveLength(1); // 僅 BET
    expect(db.txRecords[0]!.type).toBe('BET');
    expect(db.betRecords[0]!.payout).toBe(0n);
    expect(await redis.redis.get(pityCounterKey(ALICE))).toBe('1');
  });

  it('注額非檔位值 → ValidationError，不碰 DB / Redis', async () => {
    const { db, service } = setup();
    await expect(service.spin(ALICE, 20)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.spin(ALICE, -10)).rejects.toBeInstanceOf(ValidationError);
    expect(db.betRecords).toHaveLength(0);
    expect(db.txRecords).toHaveLength(0);
    expect(db.users[0]!.balance).toBe(5_000n);
  });

  it('餘額不足 → InsufficientBalanceError，整筆回滾零落帳（含 BetRecord）', async () => {
    const { db, service } = setup({ balance: 5n, rngPoints: [0, 0, 0] });

    await expect(service.spin(ALICE, 10)).rejects.toBeInstanceOf(InsufficientBalanceError);

    // ★ 回滾語義：交易內先建的 BetRecord 一併消失
    expect(db.betRecords).toHaveLength(0);
    expect(db.txRecords).toHaveLength(0);
    expect(db.users[0]).toMatchObject({ balance: 5n, version: 0 });
  });
});

// ═════════════════ loadout 快取 ═════════════════

describe('loadout 快取（slot:loadout:{userId}）', () => {
  it('首轉編譯並寫回快取；二轉 cache hit 不再查 DB', async () => {
    const { db, redis, service } = setup({ rngPoints: [0, 0, 0, 0, 0, 0] });

    await service.spin(ALICE, 10);
    expect(db.charmFindManyCalls()).toBe(1);

    const raw = await redis.redis.get(loadoutCacheKey(ALICE));
    expect(raw).not.toBeNull();
    const cached = parseCachedLoadout(raw!);
    expect(cached).not.toBeNull();
    expect(cached!.loadout.reels).toHaveLength(3);
    expect(cached!.charmCodes).toEqual([]);

    await service.spin(ALICE, 10);
    expect(db.charmFindManyCalls()).toBe(1); // 未重新編譯
  });

  it('快取損毀（非 JSON / 結構不符）→ 視為 miss 重編譯', async () => {
    const { db, redis, service } = setup({ rngPoints: [0, 0, 0] });
    await redis.redis.set(loadoutCacheKey(ALICE), 'not-json{');

    const outcome = await service.spin(ALICE, 10);
    expect(outcome.payout).toBe(40);
    expect(db.charmFindManyCalls()).toBe(1);
    // 寫回的是修復後的合法快取
    expect(parseCachedLoadout((await redis.redis.get(loadoutCacheKey(ALICE)))!)).not.toBeNull();
  });

  it('Redis get/set 故障 → 重編譯完成旋轉，交易不受影響', async () => {
    const { db, redis, service } = setup({ rngPoints: [0, 0, 0] });
    redis.failOn.add('get'); // loadout 讀取 + pity 讀取 + 幸運符號全故障
    redis.failOn.add('set');

    const outcome = await service.spin(ALICE, 10);
    expect(outcome.payout).toBe(40);
    expect(outcome.newBalance).toBe(5_030n);
    expect(db.betRecords).toHaveLength(1);
    expect(db.charmFindManyCalls()).toBe(1);
  });

  it('快取版本不符（調參後舊快取）→ 重編譯覆寫', async () => {
    const { db, redis, service } = setup({ rngPoints: [0, 0, 0] });
    // 先以真編譯產生合法快取，再竄改版本號模擬舊版
    await service.compileLoadoutForUser(ALICE).then(async (fresh) => {
      const stale = { ...fresh, loadout: { ...fresh.loadout, version: -1 } };
      await redis.redis.set(loadoutCacheKey(ALICE), JSON.stringify(stale));
    });
    expect(db.charmFindManyCalls()).toBe(1);

    await service.spin(ALICE, 10);
    expect(db.charmFindManyCalls()).toBe(2); // 版本不符觸發重編譯
  });

  it('DB 取護符失敗 → LOADOUT_COMPILE_FAILED（500）', async () => {
    const { service } = setup({ charmFindManyThrows: true });
    const err = await service.spin(ALICE, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LOADOUT_COMPILE_FAILED');
    expect((err as AppError).statusCode).toBe(500);
  });
});

// ═════════════════ 護符與加成接線 ═════════════════

describe('護符接線', () => {
  const PITY_CHARM: FakeCharmRow = {
    charm: { code: 'PITY_2_50', type: 'PITY', effect: { threshold: 2, bonus: 0.5 } },
  };

  it('PITY 護符：計數達門檻 → 倍率 ×1.5、pityActive、計數歸零、charmsUsed 落 detail', async () => {
    const { db, redis, service } = setup({ charmRows: [PITY_CHARM], rngPoints: [0, 0, 0] });
    await redis.redis.set(pityCounterKey(ALICE), '2'); // 達門檻

    const outcome = await service.spin(ALICE, 10);

    expect(outcome.payout).toBe(60); // floor(10 × 4 × 1.5)
    expect(outcome.pityActive).toBe(true);
    expect(outcome.pityCounter).toBe(0);
    expect(outcome.newBalance).toBe(5_050n);
    expect(db.betRecords[0]!.detail).toMatchObject({
      charmsUsed: ['PITY_2_50'],
      pityActive: true,
    });
    expect(await redis.redis.get(pityCounterKey(ALICE))).toBeNull();
  });

  it('PITY 未達門檻：無加成', async () => {
    const { redis, service } = setup({ charmRows: [PITY_CHARM], rngPoints: [0, 0, 0] });
    await redis.redis.set(pityCounterKey(ALICE), '1');

    const outcome = await service.spin(ALICE, 10);
    expect(outcome.payout).toBe(40);
    expect(outcome.pityActive).toBe(false);
  });

  it('今日幸運符號：連線符號命中 → 賠率 ×1.5、快取封存 luckySymbol', async () => {
    const { redis, service } = setup({ rngPoints: [0, 0, 0] });
    await redis.redis.set(DAILY_LUCKY_SYMBOL_KEY, 'CHERRY');

    const outcome = await service.spin(ALICE, 10);
    // 注意：幸運符號也使 CHERRY 權重 ×1.5（編譯期），點位 0 仍是 CHERRY
    expect(outcome.luckySymbol).toBe('CHERRY');
    expect(outcome.payout).toBe(60); // floor(10 × 4 × 1.5)
  });
});

// ═════════════════ Jackpot 點數 ═════════════════

describe('Jackpot 點數與累積', () => {
  it('DIAMOND 三連：+50 點同交易累加、回應為累加後總值、accumulate 收到注額', async () => {
    const { db, jackpot, service } = setup({
      jackpotPoints: 30,
      rngPoints: [9_100, 9_100, 9_100],
    });

    const outcome = await service.spin(ALICE, 100);

    expect(outcome.reels).toEqual(['DIAMOND', 'DIAMOND', 'DIAMOND']);
    expect(outcome.payout).toBe(6_000); // 100 × 60
    expect(outcome.jackpotPoints).toBe(80); // 30 + 50
    expect(db.users[0]!.jackpotPoints).toBe(80);
    expect(db.betRecords[0]!.detail).toMatchObject({ jackpotPointsEarned: 50 });
    expect(jackpot.calls).toEqual([100]);
  });

  it('未中獎：點數不變，accumulate 仍照常累積（1% 與輸贏無關）', async () => {
    const { db, jackpot, service } = setup({
      jackpotPoints: 7,
      rngPoints: [0, 5_700, 6_500],
    });

    const outcome = await service.spin(ALICE, 50);
    expect(outcome.jackpotPoints).toBe(7);
    expect(db.users[0]!.jackpotPoints).toBe(7);
    expect(jackpot.calls).toEqual([50]);
  });
});

// ═════════════════ M14：Jackpot 觸發與派彩接線 ═════════════════

describe('Jackpot 觸發與派彩（M14）', () => {
  it('觸發判定以「本次旋轉前」的點數計算（Diamond 本次給點不追溯）', async () => {
    const { jackpot, service } = setup({
      jackpotPoints: 100,
      rngPoints: [9_100, 9_100, 9_100], // DIAMOND 三連，本次 +50 點
    });

    await service.spin(ALICE, 100);

    expect(jackpot.triggerCalls).toEqual([100]); // 而非 150
  });

  it('未觸發：detail.jackpotTriggered=false、不呼叫 payout、jackpotPayout=null', async () => {
    const { db, jackpot, service } = setup({ rngPoints: [0, 0, 0] });

    const outcome = await service.spin(ALICE, 10);

    expect(outcome.jackpotTriggered).toBe(false);
    expect(outcome.jackpotPayout).toBeNull();
    expect(db.betRecords[0]!.detail).toMatchObject({ jackpotTriggered: false });
    expect(jackpot.payoutCalls).toHaveLength(0);
  });

  it('觸發且派彩成功：detail 與回應標記 true、jackpotPayout / newBalance / 點數歸零', async () => {
    const { db, jackpot, service } = setup({
      jackpotPoints: 200,
      rngPoints: [0, 5_700, 6_500], // 未中獎盤面——觸發不影響本次旋轉贏分
      jackpotOptions: {
        trigger: true,
        payoutResult: {
          payout: 800n,
          poolBefore: 1_000n,
          remained: 200n,
          winnerBalance: 5_790n, // 5000 − 10（注）+ 800（派彩）
        },
      },
    });

    const outcome = await service.spin(ALICE, 10);

    expect(outcome.jackpotTriggered).toBe(true);
    expect(outcome.jackpotPayout).toBe(800n);
    expect(outcome.payout).toBe(0); // 觸發不影響本次旋轉贏分（GDD §3.4.2）
    expect(outcome.newBalance).toBe(5_790n); // 含派彩入帳的 server-authoritative 餘額
    expect(outcome.jackpotPoints).toBe(0); // 派彩後點數歸零
    expect(db.betRecords[0]!.detail).toMatchObject({ jackpotTriggered: true });
    expect(jackpot.payoutCalls).toEqual([ALICE]);
  });

  it('觸發但派彩拋錯（樂觀鎖耗盡等）：spin 不拋錯、jackpotPayout=null、記錯誤日誌', async () => {
    const { db, jackpot, service, errors } = setup({
      rngPoints: [0, 0, 0],
      jackpotOptions: { trigger: true, payoutThrows: true },
    });

    const outcome = await service.spin(ALICE, 10);

    // 下注交易已提交：BetRecord / 落帳不受派彩失敗影響
    expect(outcome.payout).toBe(40);
    expect(outcome.jackpotTriggered).toBe(true); // 觸發事實已記錄，供對帳
    expect(outcome.jackpotPayout).toBeNull();
    expect(db.betRecords[0]!.detail).toMatchObject({ jackpotTriggered: true });
    expect(jackpot.payoutCalls).toEqual([ALICE]);
    expect(errors).toHaveLength(1);
  });

  it('觸發但獎池為空（payout 回 null）：jackpotPayout=null、餘額與點數不變', async () => {
    const { service } = setup({
      jackpotPoints: 30,
      rngPoints: [0, 5_700, 6_500],
      jackpotOptions: { trigger: true, payoutResult: null },
    });

    const outcome = await service.spin(ALICE, 10);

    expect(outcome.jackpotTriggered).toBe(true);
    expect(outcome.jackpotPayout).toBeNull();
    expect(outcome.newBalance).toBe(4_990n); // 僅扣注
    expect(outcome.jackpotPoints).toBe(30); // 未派彩不歸零
  });
});

// ═════════════════ pity Redis 容錯 ═════════════════

describe('pity Redis 容錯', () => {
  it('incr/del 故障：旋轉照常成功（更新失敗僅記日誌）', async () => {
    const { db, redis, service } = setup({ rngPoints: [0, 0, 0, 0, 5_700, 6_500] });
    redis.failOn.add('incr');
    redis.failOn.add('del');

    const win = await service.spin(ALICE, 10);
    expect(win.payout).toBe(40);

    const lose = await service.spin(ALICE, 10);
    expect(lose.payout).toBe(0);
    expect(db.betRecords).toHaveLength(2); // 兩筆交易皆提交
  });
});

// ═════════════════ paytable / history ═════════════════

describe('paytable / history', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup({ rngPoints: [0, 0, 0, 0, 5_700, 6_500] });
  });

  it('paytable：8 符號全列、WILD 標記、幸運符號帶出', async () => {
    await env.redis.redis.set(DAILY_LUCKY_SYMBOL_KEY, 'CLOVER');
    const result = await env.service.paytable();

    expect(result.entries).toHaveLength(8);
    expect(result.entries.find((e) => e.symbol === 'CHERRY')).toMatchObject({
      tripleMultiplier: 4,
      doubleMultiplier: 1,
      isWild: false,
    });
    expect(result.entries.find((e) => e.symbol === 'WILD')).toMatchObject({
      tripleMultiplier: 100,
      doubleMultiplier: null,
      isWild: true,
    });
    expect(result.luckySymbol).toBe('CLOVER');
    expect(result.luckyMultiplierBonus).toBe(1.5);
  });

  it('history：分頁、新到舊排序、detail 還原 reels', async () => {
    await env.service.spin(ALICE, 10); // 中獎
    await env.service.spin(ALICE, 50); // 未中

    const page1 = await env.service.history(ALICE, { page: 1, limit: 1 });
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]).toMatchObject({
      betAmount: 50,
      payout: 0,
      reels: ['CHERRY', 'LEMON', 'BELL'],
      jackpotTriggered: false,
    });

    const page2 = await env.service.history(ALICE, { page: 2, limit: 1 });
    expect(page2.items[0]).toMatchObject({ betAmount: 10, payout: 40 });
  });
});
