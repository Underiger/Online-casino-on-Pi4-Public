/**
 * admin.service 的 Telegram 2FA 推播單元測試。
 *
 * 與 admin.service.spec.ts 分開成獨立檔案的原因：這裡需要把
 * integrations/telegram.js 整檔 mock 成 telegramEnabled=true（vitest 環境下
 * 真實 env 的 TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID 預設皆空字串，
 * telegramEnabled 自然為 false）；config/env.js 也需 mock 固定
 * TELEGRAM_ADMIN_CHAT_ID 供 callback 來源比對。admin.service.spec.ts 不需要
 * 這兩個 module-level mock，混在一起會牽連既有測試。
 *
 * fake redis/prisma 比 admin.service.spec.ts 簡化：這裡的 $transaction 只
 * 寫一筆 AdminAuditLog，沒有需要回滾的併發寫入，故不需深拷貝快照。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

vi.mock('../../src/integrations/telegram.js', () => ({
  telegramEnabled: true,
  sendApprovalMessage: vi.fn(async () => ({ messageId: 111 })),
  resolveMessage: vi.fn(async () => undefined),
  answerCallbackQuery: vi.fn(async () => undefined),
  getUpdates: vi.fn(async () => []),
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return { ...actual, env: { ...actual.env, TELEGRAM_ADMIN_CHAT_ID: '999' } };
});

import { createAdminService, AUDIT_ACTIONS } from '../../src/modules/admin/admin.service.js';
import * as telegram from '../../src/integrations/telegram.js';
import { NotFoundError } from '../../src/shared/errors.js';
import type { WalletService } from '../../src/modules/wallet/wallet.service.js';

// ═════════════════ fake redis ═════════════════

function createFakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, val: string | number): Promise<'OK'> {
      store.set(key, String(val));
      return 'OK';
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
  };
  return { redis: redis as unknown as Redis, store };
}

// ═════════════════ fake prisma ═════════════════

interface FakeAuditLog {
  adminId: string;
  action: string;
  targetUserId: string | null;
  before: unknown;
  after: unknown;
  ip: string;
}

function createFakePrisma(users: Array<{ id: string; username: string }>) {
  const auditLogs: FakeAuditLog[] = [];
  const prisma: {
    user: { findUnique: (args: { where: { id: string } }) => Promise<{ username: string } | null> };
    adminAuditLog: { create: (args: { data: FakeAuditLog }) => Promise<FakeAuditLog> };
    $transaction: <T>(fn: (tx: typeof prisma) => Promise<T>) => Promise<T>;
  } = {
    user: {
      async findUnique({ where }) {
        const u = users.find((x) => x.id === where.id);
        return u !== undefined ? { username: u.username } : null;
      },
    },
    adminAuditLog: {
      async create({ data }) {
        auditLogs.push(data);
        return data;
      },
    },
    async $transaction(fn) {
      return fn(prisma);
    },
  };
  return { prisma: prisma as unknown as PrismaClient, auditLogs };
}

const FAKE_WALLET = { credit: vi.fn(), debit: vi.fn() } as unknown as Pick<
  WalletService,
  'credit' | 'debit'
>;

function buildService(
  users: Array<{ id: string; username: string }> = [{ id: 'admin1', username: 'admin' }],
) {
  const { redis, store } = createFakeRedis();
  const { prisma, auditLogs } = createFakePrisma(users);
  const service = createAdminService({ prisma, redis, wallet: FAKE_WALLET });
  return { service, store, auditLogs };
}

describe('admin.service：Telegram 2FA 推播', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requestTelegramReverify', () => {
    it('建立新的 pending 請求並送出 Telegram 訊息', async () => {
      const { service, store } = buildService();
      const res = await service.requestTelegramReverify('admin1', '1.2.3.4');

      expect(res.expiresIn).toBe(120);
      expect(telegram.sendApprovalMessage).toHaveBeenCalledTimes(1);
      expect(store.get(`admin:tg2fa:req:${res.requestId}`)).toBeDefined();
      expect(store.get(`admin:tg2fa:pending:admin1`)).toBe(res.requestId);
    });

    it('已有未過期 pending 請求時回傳同一個，不重送訊息', async () => {
      const { service } = buildService();
      const first = await service.requestTelegramReverify('admin1', '1.2.3.4');
      const second = await service.requestTelegramReverify('admin1', '1.2.3.4');

      expect(second.requestId).toBe(first.requestId);
      expect(telegram.sendApprovalMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTelegramReverifyStatus', () => {
    it('pending 狀態', async () => {
      const { service } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');
      await expect(service.getTelegramReverifyStatus('admin1', requestId)).resolves.toEqual({
        status: 'pending',
      });
    });

    it('請求不存在 → expired', async () => {
      const { service } = buildService();
      await expect(service.getTelegramReverifyStatus('admin1', 'no-such-id')).resolves.toEqual({
        status: 'expired',
      });
    });

    it('查詢別人的 requestId → NotFoundError', async () => {
      const { service } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');
      await expect(service.getTelegramReverifyStatus('someone-else', requestId)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('approved 狀態附帶 reverifyToken', async () => {
      const { service } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');
      await service.processTelegramCallback({
        id: 'cbq1',
        from: { id: 999 },
        data: `tg2fa:approve:${requestId}`,
      });

      const status = await service.getTelegramReverifyStatus('admin1', requestId);
      expect(status.status).toBe('approved');
      expect(status.reverifyToken).toBeDefined();
    });
  });

  describe('processTelegramCallback', () => {
    it('核准：發 reverifyToken + 寫稽核 + 改寫訊息', async () => {
      const { service, auditLogs } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');

      await service.processTelegramCallback({
        id: 'cbq1',
        from: { id: 999 },
        data: `tg2fa:approve:${requestId}`,
      });

      const status = await service.getTelegramReverifyStatus('admin1', requestId);
      expect(status).toEqual({ status: 'approved', reverifyToken: expect.any(String) });
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        adminId: 'admin1',
        action: AUDIT_ACTIONS.TELEGRAM_2FA_APPROVED,
      });
      expect(telegram.resolveMessage).toHaveBeenCalledWith(111, expect.stringContaining('核准'));
      expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('cbq1', '已核准');
    });

    it('拒絕：寫稽核但不發 token', async () => {
      const { service, auditLogs } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');

      await service.processTelegramCallback({
        id: 'cbq1',
        from: { id: 999 },
        data: `tg2fa:deny:${requestId}`,
      });

      const status = await service.getTelegramReverifyStatus('admin1', requestId);
      expect(status).toEqual({ status: 'denied' });
      expect(auditLogs[0]).toMatchObject({ action: AUDIT_ACTIONS.TELEGRAM_2FA_DENIED });
    });

    it('來源 chat id 不符 → 忽略，狀態不變、不寫稽核', async () => {
      const { service, auditLogs } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');

      await service.processTelegramCallback({
        id: 'cbq-intruder',
        from: { id: 12345 },
        data: `tg2fa:approve:${requestId}`,
      });

      await expect(service.getTelegramReverifyStatus('admin1', requestId)).resolves.toEqual({
        status: 'pending',
      });
      expect(auditLogs).toHaveLength(0);
      expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it('重放已處理過的請求 → 僅 ack，不重複核發 token / 寫稽核', async () => {
      const { service, auditLogs } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');

      await service.processTelegramCallback({
        id: 'cbq1',
        from: { id: 999 },
        data: `tg2fa:approve:${requestId}`,
      });
      const tokenAfterFirst = (await service.getTelegramReverifyStatus('admin1', requestId))
        .reverifyToken;

      await service.processTelegramCallback({
        id: 'cbq2',
        from: { id: 999 },
        data: `tg2fa:approve:${requestId}`,
      });
      const tokenAfterSecond = (await service.getTelegramReverifyStatus('admin1', requestId))
        .reverifyToken;

      expect(tokenAfterSecond).toBe(tokenAfterFirst);
      expect(auditLogs).toHaveLength(1);
      expect(telegram.answerCallbackQuery).toHaveBeenLastCalledWith('cbq2', '此請求已處理');
    });

    it('格式不符的 callback_data → 靜默忽略', async () => {
      const { service, auditLogs } = buildService();
      await expect(
        service.processTelegramCallback({ id: 'cbq1', from: { id: 999 }, data: 'garbage' }),
      ).resolves.toBeUndefined();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('pollTelegramUpdates', () => {
    it('處理 callback_query 並把 offset 前進到 update_id+1', async () => {
      const { service, store } = buildService();
      const { requestId } = await service.requestTelegramReverify('admin1', '1.2.3.4');

      vi.mocked(telegram.getUpdates).mockResolvedValueOnce([
        {
          update_id: 42,
          callback_query: { id: 'cbq1', from: { id: 999 }, data: `tg2fa:approve:${requestId}` },
        },
      ]);

      await service.pollTelegramUpdates();

      expect(telegram.getUpdates).toHaveBeenCalledWith(0);
      expect(store.get('admin:tg2fa:offset')).toBe('43');
      await expect(service.getTelegramReverifyStatus('admin1', requestId)).resolves.toMatchObject({
        status: 'approved',
      });
    });

    it('沒有更新時不寫 offset', async () => {
      const { service, store } = buildService();
      vi.mocked(telegram.getUpdates).mockResolvedValueOnce([]);

      await service.pollTelegramUpdates();

      expect(store.get('admin:tg2fa:offset')).toBeUndefined();
    });
  });
});
