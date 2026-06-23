/**
 * 孤兒回合清理 job 單元測試：TTL 倒推掃描邏輯 + processor 的容錯（單一使用者結算
 * 失敗不可中斷整批掃描）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAbandonedRoundProcessor,
  findStaleRoundUserIds,
} from '../../src/jobs/abandoned-round.job.js';
import { createFakeRedis } from '../helpers/slot-fakes.js';

const PREFIX = 'high-low:round:';
const ROUND_TTL = 1800;
const INACTIVITY_THRESHOLD = 300;

describe('findStaleRoundUserIds', () => {
  it('沒有任何回合 key 時回傳空陣列', async () => {
    const { redis } = createFakeRedis();
    const result = await findStaleRoundUserIds(redis, PREFIX, ROUND_TTL, INACTIVITY_THRESHOLD);
    expect(result).toEqual([]);
  });

  it('TTL 仍高於門檻（剛剛才動作過）→ 不算孤兒，不列入', async () => {
    const { redis } = createFakeRedis();
    await redis.set(`${PREFIX}user_a`, '{}', 'EX', ROUND_TTL - 10); // 只過了 10 秒
    const result = await findStaleRoundUserIds(redis, PREFIX, ROUND_TTL, INACTIVITY_THRESHOLD);
    expect(result).toEqual([]);
  });

  it('TTL 低於門檻（超過不活躍時間）→ 列為孤兒，回傳去掉 prefix 的 userId', async () => {
    const { redis } = createFakeRedis();
    await redis.set(`${PREFIX}user_a`, '{}', 'EX', ROUND_TTL - INACTIVITY_THRESHOLD - 60); // 已不活躍 360 秒
    const result = await findStaleRoundUserIds(redis, PREFIX, ROUND_TTL, INACTIVITY_THRESHOLD);
    expect(result).toEqual(['user_a']);
  });

  it('lock 鍵（:lock 結尾）一律排除，不當成回合 key', async () => {
    const { redis } = createFakeRedis();
    await redis.set(`${PREFIX}user_a:lock`, 'token', 'PX', 1000);
    const result = await findStaleRoundUserIds(redis, PREFIX, ROUND_TTL, INACTIVITY_THRESHOLD);
    expect(result).toEqual([]);
  });

  it('多個使用者只挑出真正不活躍的那些', async () => {
    const { redis } = createFakeRedis();
    await redis.set(`${PREFIX}fresh_user`, '{}', 'EX', ROUND_TTL - 5);
    await redis.set(`${PREFIX}stale_user_1`, '{}', 'EX', 100);
    await redis.set(`${PREFIX}stale_user_2`, '{}', 'EX', 50);
    const result = await findStaleRoundUserIds(redis, PREFIX, ROUND_TTL, INACTIVITY_THRESHOLD);
    expect(result.sort()).toEqual(['stale_user_1', 'stale_user_2']);
  });
});

describe('createAbandonedRoundProcessor', () => {
  function setupProcessor() {
    const { redis } = createFakeRedis();
    const highLowCalls: string[] = [];
    const blackjackCalls: string[] = [];
    const highLow = {
      resolveAbandoned: vi.fn(async (userId: string) => {
        highLowCalls.push(userId);
        return { resolved: true, outcome: 'FORFEITED' };
      }),
    };
    const blackjack = {
      resolveAbandoned: vi.fn(async (userId: string) => {
        blackjackCalls.push(userId);
        return { resolved: true, outcome: 'LOSE' };
      }),
    };
    const warnings: unknown[] = [];
    const processor = createAbandonedRoundProcessor({
      redis,
      highLow,
      blackjack,
      log: { warn: (obj) => warnings.push(obj), info: () => {} },
    });
    return { redis, highLow, blackjack, highLowCalls, blackjackCalls, warnings, processor };
  }

  it('掃到孤兒回合時，依 key 前綴呼叫對應 service 的 resolveAbandoned', async () => {
    const ctx = setupProcessor();
    await ctx.redis.set('high-low:round:user_a', '{}', 'EX', 50);
    await ctx.redis.set('blackjack:round:user_b', '{}', 'EX', 50);

    await ctx.processor();

    expect(ctx.highLowCalls).toEqual(['user_a']);
    expect(ctx.blackjackCalls).toEqual(['user_b']);
  });

  it('沒有任何孤兒回合時，兩個 service 都不會被呼叫', async () => {
    const ctx = setupProcessor();
    await ctx.processor();
    expect(ctx.highLow.resolveAbandoned).not.toHaveBeenCalled();
    expect(ctx.blackjack.resolveAbandoned).not.toHaveBeenCalled();
  });

  it('單一使用者結算失敗不可中斷整批掃描——記警告後繼續處理其他人', async () => {
    const ctx = setupProcessor();
    await ctx.redis.set('high-low:round:user_fail', '{}', 'EX', 50);
    await ctx.redis.set('high-low:round:user_ok', '{}', 'EX', 50);
    ctx.highLow.resolveAbandoned.mockImplementationOnce(async () => {
      throw new Error('db 爆炸');
    });

    await ctx.processor();

    expect(ctx.warnings.length).toBeGreaterThan(0);
    expect(ctx.highLow.resolveAbandoned).toHaveBeenCalledTimes(2); // 兩個都試過，沒有提早中斷
  });

  it('processor 本身永不拋出例外（job 失敗只記日誌，不可讓 Worker 掛掉）', async () => {
    const ctx = setupProcessor();
    ctx.redis.scan = (async () => {
      throw new Error('redis 整個掛了');
    }) as typeof ctx.redis.scan;

    await expect(ctx.processor()).resolves.toBeUndefined();
  });
});
