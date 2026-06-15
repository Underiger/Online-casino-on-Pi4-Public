/**
 * Moderation 延遲任務 processor 單元測試。
 *
 * 驗證業務意圖：到期的 timed-unmute 任務分派至 admin.releaseTimedMute；未知任務
 * 僅警告不誤動作；releaseTimedMute 拋錯時 processor 吞錯（不讓例外外溢中斷 Worker）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createModerationJobProcessor, TIMED_UNMUTE_JOB } from '../../src/jobs/timed-mute.job.js';

describe('moderation-job: timed-unmute processor', () => {
  it('timed-unmute → 以 job.data 呼叫 releaseTimedMute(userId, mutedUntil)', async () => {
    const releaseTimedMute = vi.fn(async () => ({ released: true }));
    const processor = createModerationJobProcessor({ releaseTimedMute });

    await processor({ name: TIMED_UNMUTE_JOB, data: { userId: 'u1', mutedUntil: 'T1' } });

    expect(releaseTimedMute).toHaveBeenCalledWith('u1', 'T1');
  });

  it('未知任務名稱 → 僅警告，不呼叫 releaseTimedMute', async () => {
    const releaseTimedMute = vi.fn(async () => ({ released: false }));
    const warn = vi.fn();
    const processor = createModerationJobProcessor({ releaseTimedMute, log: { warn } });

    await processor({ name: 'unknown', data: { userId: 'u1', mutedUntil: 'T1' } });

    expect(releaseTimedMute).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('releaseTimedMute 拋錯 → processor 吞錯記日誌，不外溢', async () => {
    const releaseTimedMute = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const processor = createModerationJobProcessor({ releaseTimedMute, log: { warn } });

    await expect(
      processor({ name: TIMED_UNMUTE_JOB, data: { userId: 'u1', mutedUntil: 'T1' } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
