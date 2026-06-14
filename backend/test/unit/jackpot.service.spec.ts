/**
 * Jackpot 服務單元測試（M11 累積 + M14 flush / 觸發判定 / 樂觀鎖派彩）。
 *
 * 核心驗證：
 *   - centi-coin 進位語義（M11）：小額注貢獻跨百位才進位，長期總量精確不損耗
 *   - flush 原子語義：GETSET 歸零取增量 → PG increment；PG 失敗增量放回 Redis
 *   - 觸發分母：ceil(50000 / (1 + points/1000))，下限 5000（GDD §3.4.2）
 *   - 派彩：強制 flush → 80/20 分帳 → 樂觀鎖競態重試（≤3）→ 重試耗盡拋
 *     OptimisticLockError 且整筆回滾；廣播 payload 凍結形狀；點數歸零
 */
import { describe, expect, it } from 'vitest';
import {
  createJackpotService,
  triggerDenominator,
  JACKPOT_CENTI_KEY,
  JACKPOT_DELTA_KEY,
  JACKPOT_POOL_KEY,
  JACKPOT_TXCOUNT_KEY,
  type JackpotServiceDeps,
} from '../../src/modules/jackpot/jackpot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { OptimisticLockError } from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis, type FakeDbOptions } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

interface SetupOptions {
  jackpotPool?: bigint;
  balance?: bigint;
  jackpotPoints?: number;
  bumpJackpotVersionAfterRead?: number;
  jackpotUpdateThrows?: boolean;
  /** rng 回傳值序列（觸發判定用）；耗盡後恆回 1（不觸發） */
  rngValues?: number[];
}

function setup(options: SetupOptions = {}) {
  const dbOptions: FakeDbOptions = {
    users: [
      {
        id: ALICE,
        balance: options.balance ?? 1_000n,
        jackpotPoints: options.jackpotPoints ?? 0,
        username: 'alice',
        avatarId: 7,
      },
    ],
  };
  if (options.jackpotPool !== undefined) dbOptions.jackpotPool = options.jackpotPool;
  if (options.bumpJackpotVersionAfterRead !== undefined) {
    dbOptions.bumpJackpotVersionAfterRead = options.bumpJackpotVersionAfterRead;
  }
  if (options.jackpotUpdateThrows !== undefined) {
    dbOptions.jackpotUpdateThrows = options.jackpotUpdateThrows;
  }
  const db = createFakeDb(dbOptions);
  const fakeRedis = createFakeRedis();

  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const systemMessages: string[] = [];
  const rngQueue = [...(options.rngValues ?? [])];
  const rngCalls: number[] = [];

  const deps: JackpotServiceDeps = {
    redis: fakeRedis.redis,
    prisma: db.prisma,
    wallet: createWalletService(db.prisma),
    emit: (event, payload) => emitted.push({ event, payload }),
    chat: {
      sendSystemMessage: async (content: string) => {
        systemMessages.push(content);
        return {};
      },
    },
    log: {
      warn: (obj) => warnings.push(obj),
      error: (obj) => errors.push(obj),
    },
    rng: (maxExclusive) => {
      rngCalls.push(maxExclusive);
      return rngQueue.shift() ?? 1;
    },
  };
  const jackpot = createJackpotService(deps);

  return {
    db,
    redis: fakeRedis,
    jackpot,
    warnings,
    errors,
    emitted,
    systemMessages,
    rngCalls,
  };
}

// ═════════════════ M11：accumulate ═════════════════

describe('jackpot.accumulate', () => {
  it('注 100 → 進位 1 Coin（pool/delta 各 +1、txcount +1）', async () => {
    const { redis, jackpot } = setup();

    const carry = await jackpot.accumulate(100);

    expect(carry).toBe(1);
    expect(redis.store.get(JACKPOT_CENTI_KEY)).toBe('100');
    expect(redis.store.get(JACKPOT_POOL_KEY)).toBe('1');
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('1');
    expect(redis.store.get(JACKPOT_TXCOUNT_KEY)).toBe('1');
  });

  it('注 10 × 10 次 → 前 9 次進位 0，第 10 次進位 1（小額貢獻不損耗）', async () => {
    const { redis, jackpot } = setup();

    const carries: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      carries.push(await jackpot.accumulate(10));
    }

    expect(carries).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(redis.store.get(JACKPOT_POOL_KEY)).toBe('1');
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('1');
    expect(redis.store.get(JACKPOT_TXCOUNT_KEY)).toBe('10');
  });

  it('混合注額跨位：50 + 50 + 100 → 累計 2 Coin', async () => {
    const { redis, jackpot } = setup();

    expect(await jackpot.accumulate(50)).toBe(0);
    expect(await jackpot.accumulate(50)).toBe(1); // centi 100 跨位
    expect(await jackpot.accumulate(100)).toBe(1); // centi 200 再跨位
    expect(redis.store.get(JACKPOT_POOL_KEY)).toBe('2');
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('2');
  });

  it('非法注額（0 / 負數 / 非整數）→ 0 且不碰 Redis', async () => {
    const { redis, jackpot } = setup();

    expect(await jackpot.accumulate(0)).toBe(0);
    expect(await jackpot.accumulate(-50)).toBe(0);
    expect(await jackpot.accumulate(10.5)).toBe(0);
    expect(redis.store.size).toBe(0);
  });

  it('Redis 故障 → 回 0、記警告、不拋錯（永不阻斷下注）', async () => {
    const { redis, jackpot, warnings } = setup();
    redis.failOn.add('incrby');

    await expect(jackpot.accumulate(100)).resolves.toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it('getLivePool：讀展示值；缺鍵 0n；故障 0n', async () => {
    const { redis, jackpot } = setup();

    expect(await jackpot.getLivePool()).toBe(0n);
    await jackpot.accumulate(100);
    expect(await jackpot.getLivePool()).toBe(1n);

    redis.failOn.add('get');
    expect(await jackpot.getLivePool()).toBe(0n);
  });
});

// ═════════════════ M14：flush ═════════════════

describe('jackpot.flush', () => {
  it('增量 5 → GETSET 歸零、PG pool +5、version +1、txcount 重置、回傳 5n', async () => {
    const { db, redis, jackpot } = setup({ jackpotPool: 100n });
    redis.store.set(JACKPOT_DELTA_KEY, '5');
    redis.store.set(JACKPOT_TXCOUNT_KEY, '42');

    const flushed = await jackpot.flush();

    expect(flushed).toBe(5n);
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('0');
    expect(redis.store.get(JACKPOT_TXCOUNT_KEY)).toBe('0');
    expect(db.jackpotRow.pool).toBe(105n);
    expect(db.jackpotRow.version).toBe(1);
  });

  it('增量 0 / 鍵缺省 → 不碰 PG、回 0n', async () => {
    const { db, jackpot } = setup({ jackpotPool: 100n });

    expect(await jackpot.flush()).toBe(0n);
    expect(db.jackpotRow.pool).toBe(100n);
    expect(db.jackpotRow.version).toBe(0);
  });

  it('Redis GETSET 故障 → 回 0n、記警告、不碰 PG', async () => {
    const { db, redis, jackpot, warnings } = setup({ jackpotPool: 100n });
    redis.store.set(JACKPOT_DELTA_KEY, '5');
    redis.failOn.add('getset');

    expect(await jackpot.flush()).toBe(0n);
    expect(warnings).toHaveLength(1);
    expect(db.jackpotRow.pool).toBe(100n);
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('5'); // 增量原封不動
  });

  it('PG 落庫故障 → 增量 INCRBY 放回 Redis（不遺失）、回 0n、記警告', async () => {
    const { db, redis, jackpot, warnings } = setup({
      jackpotPool: 100n,
      jackpotUpdateThrows: true,
    });
    redis.store.set(JACKPOT_DELTA_KEY, '7');

    expect(await jackpot.flush()).toBe(0n);
    expect(db.jackpotRow.pool).toBe(100n);
    expect(redis.store.get(JACKPOT_DELTA_KEY)).toBe('7'); // GETSET 取走後又放回
    expect(warnings).toHaveLength(1);
  });

  it('restoreLivePool：展示值 = pool(DB) + delta(Redis)（GDD §3.4.1 重啟恢復）', async () => {
    const { redis, jackpot } = setup({ jackpotPool: 900n });
    redis.store.set(JACKPOT_DELTA_KEY, '23');

    await jackpot.restoreLivePool();

    expect(redis.store.get(JACKPOT_POOL_KEY)).toBe('923');
  });
});

// ═════════════════ M14：觸發判定 ═════════════════

describe('jackpot 觸發判定', () => {
  it('triggerDenominator 對照表：0 點 50000 / 100 點 45455 / 1000 點 25000 / 上限 5000', () => {
    expect(triggerDenominator(0)).toBe(50_000);
    // 100 點 = +10% 相對機率：ceil(50000 / 1.1) = 45455
    expect(triggerDenominator(100)).toBe(45_455);
    // 1000 點 = ×2 機率
    expect(triggerDenominator(1_000)).toBe(25_000);
    // 9000 點 → ceil(50000/10) = 5000（恰達上限）
    expect(triggerDenominator(9_000)).toBe(5_000);
    // 超大點數 → 分母鉗在 5000（機率上限 1/5,000）
    expect(triggerDenominator(1_000_000)).toBe(5_000);
    // 防禦：負數 / 非整數視為 0 點
    expect(triggerDenominator(-5)).toBe(50_000);
  });

  it('tryTriggerJackpot：rng(分母)===0 觸發；非 0 不觸發；分母正確傳遞', () => {
    const { jackpot, rngCalls } = setup({ rngValues: [0, 1, 0] });

    expect(jackpot.tryTriggerJackpot(0)).toBe(true);
    expect(jackpot.tryTriggerJackpot(100)).toBe(false);
    expect(jackpot.tryTriggerJackpot(1_000)).toBe(true);
    expect(rngCalls).toEqual([50_000, 45_455, 25_000]);
  });
});

// ═════════════════ M14：派彩（樂觀鎖） ═════════════════

describe('jackpot.payout', () => {
  it('happy path：強制 flush → 80/20 分帳 → 入帳 + History + 點數歸零 + 廣播 + 系統訊息', async () => {
    const { db, redis, jackpot, emitted, systemMessages } = setup({
      jackpotPool: 900n,
      balance: 1_000n,
      jackpotPoints: 250,
    });
    // 未落庫增量 100 → 強制 flush 後 pool = 1000
    redis.store.set(JACKPOT_DELTA_KEY, '100');
    redis.store.set(JACKPOT_POOL_KEY, '1000'); // 展示值（DB 900 + delta 100）

    const result = await jackpot.payout(ALICE);

    // 分帳：floor(1000 × 0.8) = 800、留底 200
    expect(result).not.toBeNull();
    expect(result?.payout).toBe(800n);
    expect(result?.poolBefore).toBe(1_000n);
    expect(result?.remained).toBe(200n);
    expect(result?.winnerBalance).toBe(1_800n);

    // PG 真值：pool=200、version 經 flush(+1) 與派彩(+1) 共 2
    expect(db.jackpotRow.pool).toBe(200n);
    expect(db.jackpotRow.version).toBe(2);

    // 餘額鐵律：wallet.credit 落 BalanceTransaction（type JACKPOT、refId=History.id）
    expect(db.users[0]!.balance).toBe(1_800n);
    expect(db.txRecords).toHaveLength(1);
    expect(db.txRecords[0]).toMatchObject({
      userId: ALICE,
      type: 'JACKPOT',
      delta: 800n,
      balanceBefore: 1_000n,
      balanceAfter: 1_800n,
      refId: db.jackpotHistory[0]!.id,
    });

    // JackpotHistory 永久保存
    expect(db.jackpotHistory).toHaveLength(1);
    expect(db.jackpotHistory[0]).toMatchObject({
      userId: ALICE,
      poolBefore: 1_000n,
      payout: 800n,
      remained: 200n,
    });

    // 觸發後點數歸零（GDD §3.4.2-1）
    expect(db.users[0]!.jackpotPoints).toBe(0);

    // 展示值 DECRBY payout（保留派彩窗口內的併發增量）：1000 - 800 = 200
    expect(redis.store.get(JACKPOT_POOL_KEY)).toBe('200');

    // jackpot:won 廣播（payload 凍結於 docs/04_API_SPEC.md §4.3）
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      event: 'jackpot:won',
      payload: {
        userId: ALICE,
        username: 'alice',
        avatarId: 7,
        payout: '800',
        poolBefore: '1000',
      },
    });

    // 聊天室系統訊息
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('alice');
    expect(systemMessages[0]).toContain('800');
  });

  it('樂觀鎖競態 1 次（讀取後 version 被搶寫）→ 重試後成功', async () => {
    const { db, jackpot, warnings } = setup({
      jackpotPool: 1_000n,
      bumpJackpotVersionAfterRead: 1,
    });

    const result = await jackpot.payout(ALICE);

    expect(result?.payout).toBe(800n);
    expect(db.jackpotRow.pool).toBe(200n);
    expect(db.jackpotHistory).toHaveLength(1); // 重試只成功落帳一次（無雙重支付）
    expect(db.txRecords).toHaveLength(1);
    expect(warnings.length).toBeGreaterThanOrEqual(1); // 競態重試有日誌
  });

  it('競態 3 次（重試耗盡）→ OptimisticLockError、零落帳（回滾語義）', async () => {
    const { db, jackpot } = setup({
      jackpotPool: 1_000n,
      bumpJackpotVersionAfterRead: 3,
    });

    await expect(jackpot.payout(ALICE)).rejects.toBeInstanceOf(OptimisticLockError);

    // 整筆回滾：pool 未被改動（version 僅競態注入的 +3）、無 History、無入帳、點數未動
    expect(db.jackpotRow.pool).toBe(1_000n);
    expect(db.jackpotHistory).toHaveLength(0);
    expect(db.txRecords).toHaveLength(0);
    expect(db.users[0]!.balance).toBe(1_000n);
  });

  it('獎池為空 → 回 null、不落任何帳', async () => {
    const { db, jackpot, emitted } = setup({ jackpotPool: 0n });

    expect(await jackpot.payout(ALICE)).toBeNull();
    expect(db.jackpotHistory).toHaveLength(0);
    expect(db.txRecords).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('廣播 / 系統訊息故障 → 派彩結果不受影響（後置作業失敗僅記日誌）', async () => {
    // decrby（展示值更新）/ emit / chat 三項後置作業同時故障
    const { db, warnings } = setup({ jackpotPool: 1_000n });

    const failing = createJackpotService({
      redis: createFakeRedisWithDecrbyFailure(),
      prisma: db.prisma,
      wallet: createWalletService(db.prisma),
      emit: () => {
        throw new Error('socket down');
      },
      chat: {
        sendSystemMessage: async () => {
          throw new Error('chat down');
        },
      },
      log: { warn: (obj) => warnings.push(obj) },
    });

    const result = await failing.payout(ALICE);

    expect(result?.payout).toBe(800n);
    expect(db.jackpotRow.pool).toBe(200n);
    expect(db.jackpotHistory).toHaveLength(1);
    // decrby + emit + chat 三項後置故障 → 三條警告，派彩不拋錯
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

/** 後置作業容錯測試專用：decrby 必炸、其餘命令正常 */
function createFakeRedisWithDecrbyFailure() {
  const { redis, failOn } = createFakeRedis();
  failOn.add('decrby');
  return redis;
}

// ═════════════════ M14：pool 查詢 ═════════════════

describe('jackpot.getPoolStatus / getHistory', () => {
  it('getPoolStatus = pool(DB) + delta(Redis)；Redis 故障退化為 DB 真值', async () => {
    const { redis, jackpot, warnings } = setup({ jackpotPool: 500n });
    redis.store.set(JACKPOT_DELTA_KEY, '30');

    expect((await jackpot.getPoolStatus()).pool).toBe(530n);

    redis.failOn.add('get');
    expect((await jackpot.getPoolStatus()).pool).toBe(500n);
    expect(warnings).toHaveLength(1);
  });

  it('getHistory：分頁 + JOIN user（username/avatarId）', async () => {
    const { jackpot } = setup({ jackpotPool: 1_000n });
    await jackpot.payout(ALICE);

    const page = await jackpot.getHistory({ page: 1, limit: 10 });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      userId: ALICE,
      username: 'alice',
      avatarId: 7,
      poolBefore: 1_000n,
      payout: 800n,
      remained: 200n,
    });
  });
});
