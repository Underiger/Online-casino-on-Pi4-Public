/**
 * Telegram 2FA 短輪詢任務 processor 單元測試。
 *
 * 驗證業務意圖：poll 任務分派至 admin.pollTelegramUpdates；未知任務僅警告不誤動作；
 * pollTelegramUpdates 拋錯時 processor 吞錯（不讓例外外溢中斷 Worker，下次迭代重試）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramPollProcessor,
  TELEGRAM_POLL_JOB,
} from '../../src/jobs/telegram-2fa-poll.job.js';

/**
 * 模擬真實 pino instance 的方法綁定行為：error/warn 依賴 prototype 上的
 * this.someInternalState，取出函式參考後脫離 this 呼叫會拋 TypeError——
 * 純物件 mock（{ warn: vi.fn() }）無法重現這個情境，這正是先前 production
 * bug（log.error ?? log.warn 取出參考呼叫）能在單元測試全綠下溜進生產的原因。
 */
class FakePinoLogger {
  calls: Array<{ level: string; obj: unknown; msg?: string }> = [];
  #prefix = 'fake-pino';

  error(obj: unknown, msg?: string): void {
    if (this.#prefix === undefined) throw new TypeError('this 未綁定');
    this.calls.push({ level: 'error', obj, msg });
  }

  warn(obj: unknown, msg?: string): void {
    if (this.#prefix === undefined) throw new TypeError('this 未綁定');
    this.calls.push({ level: 'warn', obj, msg });
  }
}

describe('telegram-2fa-job: poll processor', () => {
  it('poll → 呼叫 pollTelegramUpdates', async () => {
    const pollTelegramUpdates = vi.fn(async () => undefined);
    const processor = createTelegramPollProcessor({ pollTelegramUpdates });

    await processor({ name: TELEGRAM_POLL_JOB });

    expect(pollTelegramUpdates).toHaveBeenCalledTimes(1);
  });

  it('未知任務名稱 → 僅警告，不呼叫 pollTelegramUpdates', async () => {
    const pollTelegramUpdates = vi.fn(async () => undefined);
    const warn = vi.fn();
    const processor = createTelegramPollProcessor({ pollTelegramUpdates, log: { warn } });

    await processor({ name: 'unknown' });

    expect(pollTelegramUpdates).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('pollTelegramUpdates 拋錯 → processor 吞錯記日誌，不外溢', async () => {
    const pollTelegramUpdates = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const processor = createTelegramPollProcessor({ pollTelegramUpdates, log: { warn } });

    await expect(processor({ name: TELEGRAM_POLL_JOB })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('真實 pino 風格 logger（方法依賴 this 綁定）拋錯時仍能正常記錄，不脫離 this 呼叫', async () => {
    const pollTelegramUpdates = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = new FakePinoLogger();
    const processor = createTelegramPollProcessor({ pollTelegramUpdates, log });

    await expect(processor({ name: TELEGRAM_POLL_JOB })).resolves.toBeUndefined();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.level).toBe('error');
  });
});
