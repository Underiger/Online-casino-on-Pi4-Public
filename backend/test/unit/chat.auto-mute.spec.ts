/**
 * 聊天洗頻自動禁言（auto-mute）單元測試。
 *
 * 驗證「分鐘桶於視窗內連續被擋達閾值 → 呼叫注入的 autoMute（限時禁言）」這個
 * 業務意圖（M27 安全演練建議）：洗頻不只被限流擋下，達閾值即自動禁言。
 *
 * 採自包覆 fake：redis.eval 對分鐘桶恆回 [0]（擋）、burst 桶恆回 [1]（放行），
 * 使每次 sendMessage 都落在 minute_exceeded 分支；incr/expire/del 支撐洗頻計數。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createChatService } from '../../src/modules/chat/chat.service.js';

/** burst 桶放行、分鐘桶恆擋（→ checkRateLimit 回 minute_exceeded）；支援洗頻計數 */
function createAutoMuteRedis(): Redis {
  const counters = new Map<string, number>();
  const redis = {
    async eval(_lua: string, _numKeys: number, key: string): Promise<[number, number]> {
      return key.includes(':min:') ? [0, 0] : [1, 0];
    },
    async incr(key: string): Promise<number> {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    },
    async expire(): Promise<number> {
      return 1;
    },
    async del(key: string): Promise<number> {
      return counters.delete(key) ? 1 : 0;
    },
  };
  return redis as unknown as Redis;
}

/** 使用者存在、未封禁未禁言 → 流程得以走到頻率限制 */
function okUserPrisma(): PrismaClient {
  return {
    user: {
      async findUnique(): Promise<{ banned: boolean; muted: boolean }> {
        return { banned: false, muted: false };
      },
    },
  } as unknown as PrismaClient;
}

describe('chat.service: 洗頻自動禁言（auto-mute）', () => {
  it('分鐘桶連續被擋達閾值（5）→ 恰觸發一次 autoMute(userId)', async () => {
    const autoMute = vi.fn(async () => {});
    const service = createChatService({
      prisma: okUserPrisma(),
      redis: createAutoMuteRedis(),
      autoMute,
    });

    for (let i = 0; i < 5; i += 1) {
      const r = await service.sendMessage('u1', 'spam spam');
      expect(r).toEqual({ reason: 'RATE_LIMIT_MINUTE' });
    }

    expect(autoMute).toHaveBeenCalledTimes(1);
    expect(autoMute).toHaveBeenCalledWith('u1');
  });

  it('未達閾值（4 次）→ 不觸發自動禁言', async () => {
    const autoMute = vi.fn(async () => {});
    const service = createChatService({
      prisma: okUserPrisma(),
      redis: createAutoMuteRedis(),
      autoMute,
    });

    for (let i = 0; i < 4; i += 1) await service.sendMessage('u1', 'spam');
    expect(autoMute).not.toHaveBeenCalled();
  });

  it('未注入 autoMute → 洗頻僅被限流擋下，不拋錯', async () => {
    const service = createChatService({
      prisma: okUserPrisma(),
      redis: createAutoMuteRedis(),
    });

    for (let i = 0; i < 6; i += 1) {
      const r = await service.sendMessage('u1', 'spam');
      expect(r).toEqual({ reason: 'RATE_LIMIT_MINUTE' });
    }
  });
});
