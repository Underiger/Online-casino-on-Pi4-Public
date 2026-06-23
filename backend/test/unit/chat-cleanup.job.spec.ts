/**
 * Chat Cleanup job 單元測試：processor 工廠與 BullMQ 接線分離，
 * 直接以 fake deps 驅動（同 monitor-scan/abandoned-round 慣例）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createChatCleanupProcessor } from '../../src/jobs/chat-cleanup.job.js';

describe('createChatCleanupProcessor', () => {
  it('呼叫 chat.cleanupOldMessages 並記錄清理筆數', async () => {
    const cleanupOldMessages = vi.fn(async () => 3);
    const infoLogs: unknown[] = [];
    const processor = createChatCleanupProcessor({
      chat: { cleanupOldMessages },
      log: { warn: () => {}, info: (obj) => infoLogs.push(obj) },
    });

    await processor();

    expect(cleanupOldMessages).toHaveBeenCalledTimes(1);
    expect(infoLogs).toEqual([{ count: 3 }]);
  });

  it('cleanupOldMessages 拋錯時只記警告，processor 本身不拋出（job 失敗不可讓 Worker 掛掉）', async () => {
    const cleanupOldMessages = vi.fn(async () => {
      throw new Error('db 爆炸');
    });
    const warnings: unknown[] = [];
    const processor = createChatCleanupProcessor({
      chat: { cleanupOldMessages },
      log: { warn: (obj) => warnings.push(obj) },
    });

    await expect(processor()).resolves.toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  it('未注入 log 時仍可正常執行（log 為選填）', async () => {
    const cleanupOldMessages = vi.fn(async () => 0);
    const processor = createChatCleanupProcessor({ chat: { cleanupOldMessages } });

    await expect(processor()).resolves.toBeUndefined();
    expect(cleanupOldMessages).toHaveBeenCalledTimes(1);
  });
});
