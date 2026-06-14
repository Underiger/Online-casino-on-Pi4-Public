/**
 * Jackpot flush / tick job processor 單元測試（M14）。
 *
 * processor 與 BullMQ 接線分離（createJackpotJobProcessor 工廠）——
 * 以 fake deps 直接驅動，驗證任務分派、提前 flush 門檻、廣播 payload
 * 與「任何故障僅記日誌、永不外溢」的保險絲語義。
 */
import { describe, expect, it } from 'vitest';
import {
  createJackpotJobProcessor,
  JACKPOT_FLUSH_JOB,
  JACKPOT_FLUSH_TXCOUNT_THRESHOLD,
  JACKPOT_TICK_JOB,
} from '../../src/jobs/jackpot-flush.job.js';
import { JACKPOT_TXCOUNT_KEY } from '../../src/modules/jackpot/jackpot.service.js';
import { SOCKET_EVENTS } from '../../src/sockets/events.js';
import { createFakeRedis } from '../helpers/slot-fakes.js';

interface SetupOptions {
  txcount?: number;
  livePool?: bigint;
  flushThrows?: boolean;
}

function setup(options: SetupOptions = {}) {
  const fakeRedis = createFakeRedis();
  if (options.txcount !== undefined) {
    fakeRedis.store.set(JACKPOT_TXCOUNT_KEY, String(options.txcount));
  }

  const flushCalls: number[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const warnings: unknown[] = [];
  const errors: unknown[] = [];

  const processor = createJackpotJobProcessor({
    jackpot: {
      flush: async () => {
        flushCalls.push(1);
        if (options.flushThrows) throw new Error('flush exploded');
        return 0n;
      },
      getLivePool: async () => options.livePool ?? 0n,
    },
    redis: fakeRedis.redis,
    emit: (event, payload) => emitted.push({ event, payload }),
    log: { warn: (obj) => warnings.push(obj), error: (obj) => errors.push(obj) },
  });

  return { processor, fakeRedis, flushCalls, emitted, warnings, errors };
}

describe('jackpot-flush.job processor', () => {
  it('flush 任務 → 呼叫 jackpot.flush 一次、不廣播', async () => {
    const { processor, flushCalls, emitted } = setup();

    await processor({ name: JACKPOT_FLUSH_JOB });

    expect(flushCalls).toHaveLength(1);
    expect(emitted).toHaveLength(0);
  });

  it('tick 任務 → 廣播 jackpot:tick { pool: string }（payload 凍結形狀）', async () => {
    const { processor, flushCalls, emitted } = setup({ livePool: 12_345n });

    await processor({ name: JACKPOT_TICK_JOB });

    expect(emitted).toEqual([
      { event: SOCKET_EVENTS.JACKPOT_TICK, payload: { pool: '12345' } },
    ]);
    // txcount 未達門檻 → 不提前 flush
    expect(flushCalls).toHaveLength(0);
  });

  it(`tick 任務：txcount ≥ ${JACKPOT_FLUSH_TXCOUNT_THRESHOLD} → 提前 flush 後再廣播`, async () => {
    const { processor, flushCalls, emitted } = setup({
      txcount: JACKPOT_FLUSH_TXCOUNT_THRESHOLD,
      livePool: 999n,
    });

    await processor({ name: JACKPOT_TICK_JOB });

    expect(flushCalls).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('tick 任務：txcount 門檻邊界（499）→ 不提前 flush', async () => {
    const { processor, flushCalls } = setup({
      txcount: JACKPOT_FLUSH_TXCOUNT_THRESHOLD - 1,
    });

    await processor({ name: JACKPOT_TICK_JOB });

    expect(flushCalls).toHaveLength(0);
  });

  it('tick 任務：txcount 讀取故障 → 記警告、跳過提前 flush、廣播照常', async () => {
    const { processor, fakeRedis, flushCalls, emitted, warnings } = setup({ livePool: 5n });
    fakeRedis.failOn.add('get');

    await processor({ name: JACKPOT_TICK_JOB });

    expect(warnings).toHaveLength(1);
    expect(flushCalls).toHaveLength(0);
    expect(emitted).toHaveLength(1);
  });

  it('flush 內部拋錯 → 保險絲攔截、記錯誤日誌、processor 不外溢例外', async () => {
    const { processor, errors } = setup({ flushThrows: true });

    await expect(processor({ name: JACKPOT_FLUSH_JOB })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('未知任務名稱 → 記警告、不執行任何動作', async () => {
    const { processor, flushCalls, emitted, warnings } = setup();

    await processor({ name: 'mystery-job' });

    expect(warnings).toHaveLength(1);
    expect(flushCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});
