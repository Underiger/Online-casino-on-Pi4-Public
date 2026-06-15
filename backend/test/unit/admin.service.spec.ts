/**
 * admin.service 單元測試（M21 DoD）。
 *
 * 採 in-memory fake prisma（$transaction 以深拷貝快照 + 拋錯還原模擬回滾，與
 * wallet.service.spec 同款，確保調幣失敗零落帳）+ fake redis（Map 後端），
 * 並注入「真」wallet.service——調幣走真實 credit/debit + BalanceTransaction 落帳。
 *
 * 覆蓋：2FA 綁定/確認/驗證/重驗（含防重用、備用碼一次性）、reverifyToken 檢查、
 * 封鎖（踢線 + 撤銷會話 + 稽核）、禁言、調幣（成功 + 餘額不足回滾）、
 * 公告 CRUD + 廣播、Gift Code 產生/列表遮蔽、稽核日誌查詢。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createAdminService, AUDIT_ACTIONS } from '../../src/modules/admin/admin.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  encryptSecret,
  currentTotp,
  generateTotpSecret,
  generateRecoveryCodes,
} from '../../src/security/totp.js';
import {
  ConflictError,
  ForbiddenError,
  InsufficientBalanceError,
  NotFoundError,
  UnauthorizedError,
} from '../../src/shared/errors.js';

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

interface FakeUser {
  id: string;
  username: string;
  role: 'PLAYER' | 'ADMIN';
  balance: bigint;
  version: number;
  banned: boolean;
  muted: boolean;
  flagged: boolean;
  avatarId: number;
  jackpotPoints: number;
  loginStreak: number;
  totpEnabled: boolean;
  totpSecretEnc: string | null;
  recoveryCodes: string | null;
  lastDailyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  [k: string]: unknown;
}

function createFakeDb(seedUsers: Array<Partial<FakeUser> & { id: string }>) {
  const state = {
    users: seedUsers.map(
      (u, i): FakeUser => ({
        username: `user${i}`,
        role: 'PLAYER',
        balance: 1000n,
        version: 0,
        banned: false,
        muted: false,
        flagged: false,
        avatarId: 0,
        jackpotPoints: 0,
        loginStreak: 0,
        totpEnabled: false,
        totpSecretEnc: null,
        recoveryCodes: null,
        lastDailyAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...u,
      }),
    ),
    txRecords: [] as Row[],
    refreshTokens: [] as Array<{ id: string; userId: string; revoked: boolean }>,
    loginLogs: [] as Array<{ userId: string; result: string; ip: string; createdAt: Date }>,
    auditLogs: [] as Row[],
    announcements: [] as Row[],
    giftCodes: [] as Row[],
  };
  let seq = 0;
  const nextId = (p: string): string => `${p}_${(seq += 1)}`;

  const findUser = (id: string): FakeUser | undefined => state.users.find((u) => u.id === id);

  const client = {
    user: {
      async findUnique({ where }: { where: { id: string } }): Promise<FakeUser | null> {
        return findUser(where.id) ?? null;
      },
      async findUniqueOrThrow({ where }: { where: { id: string } }): Promise<FakeUser> {
        const u = findUser(where.id);
        if (u === undefined) throw new Error('not found');
        return u;
      },
      // 條件更新（wallet 用）：條件檢查 + 變更同步完成＝ SQL 原子性
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; balance?: { gte: bigint } };
        data: { balance?: { increment?: bigint; decrement?: bigint }; version?: { increment: number } };
      }): Promise<{ count: number }> {
        const matched = state.users.filter(
          (u) => u.id === where.id && (where.balance?.gte === undefined || u.balance >= where.balance.gte),
        );
        for (const u of matched) {
          if (data.balance?.increment !== undefined) u.balance += data.balance.increment;
          if (data.balance?.decrement !== undefined) u.balance -= data.balance.decrement;
          if (data.version?.increment !== undefined) u.version += data.version.increment;
        }
        return { count: matched.length };
      },
      // 非餘額欄位更新（admin 用）
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeUser>;
      }): Promise<FakeUser> {
        const u = findUser(where.id);
        if (u === undefined) throw new Error('not found');
        Object.assign(u, data);
        return u;
      },
      async findMany({
        where,
        skip = 0,
        take = 100,
      }: {
        where?: {
          OR?: Array<{ username?: { contains: string }; id?: string }>;
          banned?: boolean;
          flagged?: boolean;
          id?: { in: string[] };
        };
        skip?: number;
        take?: number;
      } = {}): Promise<FakeUser[]> {
        let rows = state.users;
        if (where?.id?.in !== undefined) {
          const set = new Set(where.id.in);
          rows = rows.filter((u) => set.has(u.id));
        }
        if (where?.banned !== undefined) rows = rows.filter((u) => u.banned === where.banned);
        if (where?.flagged !== undefined) rows = rows.filter((u) => u.flagged === where.flagged);
        if (where?.OR !== undefined) {
          rows = rows.filter((u) =>
            where.OR!.some(
              (c) =>
                (c.username?.contains !== undefined &&
                  u.username.toLowerCase().includes(c.username.contains.toLowerCase())) ||
                (c.id !== undefined && u.id === c.id),
            ),
          );
        }
        return rows.slice(skip, skip + take);
      },
      async count({ where }: { where?: { banned?: boolean; flagged?: boolean } } = {}): Promise<number> {
        let rows = state.users;
        if (where?.banned !== undefined) rows = rows.filter((u) => u.banned === where.banned);
        if (where?.flagged !== undefined) rows = rows.filter((u) => u.flagged === where.flagged);
        return rows.length;
      },
    },
    balanceTransaction: {
      async create({ data }: { data: Row }): Promise<Row> {
        const row = { id: nextId('tx'), createdAt: new Date(), ...data };
        state.txRecords.push(row);
        return row;
      },
    },
    refreshToken: {
      async updateMany({
        where,
        data,
      }: {
        where: { userId: string; revoked: boolean };
        data: { revoked: boolean };
      }): Promise<{ count: number }> {
        const matched = state.refreshTokens.filter(
          (t) => t.userId === where.userId && t.revoked === where.revoked,
        );
        for (const t of matched) t.revoked = data.revoked;
        return { count: matched.length };
      },
    },
    loginLog: {
      async findMany({ where, take = 100 }: { where: { userId: string }; take?: number }): Promise<Row[]> {
        return state.loginLogs.filter((l) => l.userId === where.userId).slice(0, take);
      },
    },
    adminAuditLog: {
      async create({ data }: { data: Row }): Promise<Row> {
        const row = { id: nextId('audit'), createdAt: new Date(), ...data };
        state.auditLogs.push(row);
        return row;
      },
      async findMany({
        where,
        skip = 0,
        take = 100,
      }: {
        where?: { adminId?: string; action?: string; targetUserId?: string };
        skip?: number;
        take?: number;
      } = {}): Promise<Row[]> {
        let rows = [...state.auditLogs].reverse(); // createdAt desc
        if (where?.adminId !== undefined) rows = rows.filter((r) => r['adminId'] === where.adminId);
        if (where?.action !== undefined) rows = rows.filter((r) => r['action'] === where.action);
        if (where?.targetUserId !== undefined)
          rows = rows.filter((r) => r['targetUserId'] === where.targetUserId);
        return rows.slice(skip, skip + take);
      },
      async count({ where }: { where?: { action?: string } } = {}): Promise<number> {
        let rows = state.auditLogs;
        if (where?.action !== undefined) rows = rows.filter((r) => r['action'] === where.action);
        return rows.length;
      },
    },
    announcement: {
      async create({ data }: { data: Row }): Promise<Row> {
        const row = { id: nextId('ann'), createdAt: new Date(), ...data };
        state.announcements.push(row);
        return row;
      },
      async findUnique({ where }: { where: { id: string } }): Promise<Row | null> {
        return state.announcements.find((a) => a['id'] === where.id) ?? null;
      },
      async findMany({
        where,
      }: {
        where?: { active?: boolean; startsAt?: { lte: Date }; OR?: unknown };
      } = {}): Promise<Row[]> {
        let rows = [...state.announcements];
        if (where?.active !== undefined) rows = rows.filter((a) => a['active'] === where.active);
        if (where?.startsAt?.lte !== undefined) {
          const lte = where.startsAt.lte.getTime();
          rows = rows.filter((a) => (a['startsAt'] as Date).getTime() <= lte);
          // endsAt null 或 >= now
          const now = lte;
          rows = rows.filter((a) => a['endsAt'] === null || (a['endsAt'] as Date).getTime() >= now);
        }
        return rows;
      },
      async update({ where, data }: { where: { id: string }; data: Row }): Promise<Row> {
        const a = state.announcements.find((x) => x['id'] === where.id);
        if (a === undefined) throw new Error('not found');
        Object.assign(a, data);
        return a;
      },
      async delete({ where }: { where: { id: string } }): Promise<Row> {
        const idx = state.announcements.findIndex((x) => x['id'] === where.id);
        if (idx === -1) throw new Error('not found');
        return state.announcements.splice(idx, 1)[0]!;
      },
    },
    giftCode: {
      async create({ data }: { data: Row }): Promise<Row> {
        const row = { id: nextId('gc'), usedCount: 0, createdAt: new Date(), ...data };
        state.giftCodes.push(row);
        return row;
      },
      async findMany({ skip = 0, take = 100 }: { skip?: number; take?: number } = {}): Promise<Row[]> {
        return [...state.giftCodes].reverse().slice(skip, skip + take);
      },
      async count(): Promise<number> {
        return state.giftCodes.length;
      },
    },
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      // 深拷貝快照（bigint/Date 由 structuredClone 支援）；拋錯時整批還原＝回滾
      const snapshot = structuredClone({
        users: state.users,
        txRecords: state.txRecords,
        auditLogs: state.auditLogs,
        announcements: state.announcements,
        giftCodes: state.giftCodes,
        refreshTokens: state.refreshTokens,
      });
      try {
        return await fn(client);
      } catch (err) {
        state.users.splice(0, state.users.length, ...snapshot.users);
        state.txRecords.splice(0, state.txRecords.length, ...snapshot.txRecords);
        state.auditLogs.splice(0, state.auditLogs.length, ...snapshot.auditLogs);
        state.announcements.splice(0, state.announcements.length, ...snapshot.announcements);
        state.giftCodes.splice(0, state.giftCodes.length, ...snapshot.giftCodes);
        state.refreshTokens.splice(0, state.refreshTokens.length, ...snapshot.refreshTokens);
        throw err;
      }
    },
  };

  return { client, state };
}

// ═════════════════ 測試組裝 ═════════════════

function setup(seedUsers: Array<Partial<FakeUser> & { id: string }>) {
  const { client, state } = createFakeDb(seedUsers);
  const { redis, store } = createFakeRedis();
  const prisma = client as unknown as PrismaClient;
  const wallet = createWalletService(prisma);
  const disconnectUser = vi.fn();
  const emitAnnouncement = vi.fn();
  const hmacRevoke = vi.fn(async () => {});
  const service = createAdminService({
    prisma,
    redis,
    wallet,
    hmacKeys: { revoke: hmacRevoke },
    disconnectUser,
    emitAnnouncement,
  });
  return { service, state, store, disconnectUser, emitAnnouncement, hmacRevoke };
}

/** 建立一個已啟用 2FA 的 admin，回傳其明文 secret */
function enableTotp(user: Partial<FakeUser> & { id: string }): {
  user: Partial<FakeUser> & { id: string };
  secret: string;
} {
  const secret = generateTotpSecret();
  return {
    user: { ...user, role: 'ADMIN', totpEnabled: true, totpSecretEnc: encryptSecret(secret) },
    secret,
  };
}

// ═════════════════ 2FA / TOTP ═════════════════

describe('admin.service: TOTP 綁定與確認', () => {
  it('setupTotp 產生並加密 secret（尚未啟用），回 QR URI + secret', async () => {
    const { service, state } = setup([{ id: 'a1', role: 'ADMIN', username: 'admin' }]);
    const res = await service.setupTotp('a1', 'admin');
    expect(res.qrUri.startsWith('otpauth://totp/')).toBe(true);
    expect(res.secret.length).toBeGreaterThan(10);
    const u = state.users.find((x) => x.id === 'a1')!;
    expect(u.totpSecretEnc).not.toBeNull();
    expect(u.totpEnabled).toBe(false); // verify 之前不啟用
  });

  it('已啟用 2FA 時 setupTotp → ConflictError', async () => {
    const { user } = enableTotp({ id: 'a1', username: 'admin' });
    const { service } = setup([user]);
    await expect(service.setupTotp('a1', 'admin')).rejects.toBeInstanceOf(ConflictError);
  });

  it('confirmTotp：錯誤碼拋 Unauthorized；正確碼啟用 + 回 10 組備用碼 + 寫稽核', async () => {
    const secret = generateTotpSecret();
    const { service, state } = setup([
      { id: 'a1', role: 'ADMIN', username: 'admin', totpSecretEnc: encryptSecret(secret) },
    ]);
    await expect(service.confirmTotp('a1', '000000', '127.0.0.1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    const res = await service.confirmTotp('a1', currentTotp(secret), '127.0.0.1');
    expect(res.enabled).toBe(true);
    expect(res.recoveryCodes).toHaveLength(10);
    const u = state.users.find((x) => x.id === 'a1')!;
    expect(u.totpEnabled).toBe(true);
    expect(u.recoveryCodes).not.toBeNull();
    expect(state.auditLogs.some((a) => a['action'] === AUDIT_ACTIONS.ENABLE_TOTP)).toBe(true);
  });
});

describe('admin.service: 2FA 驗證與重驗', () => {
  it('validate2fa：正確 TOTP → 簽發 reverifyToken，且 token 可被 checkReverifyToken 驗證', async () => {
    const { user, secret } = enableTotp({ id: 'a1', username: 'admin' });
    const { service } = setup([user]);
    const { reverifyToken } = await service.validate2fa('a1', currentTotp(secret));
    expect(reverifyToken.length).toBeGreaterThan(10);
    expect(await service.checkReverifyToken('a1', reverifyToken)).toBe(true);
    // 不同使用者不可使用
    expect(await service.checkReverifyToken('other', reverifyToken)).toBe(false);
    // 不存在的 token
    expect(await service.checkReverifyToken('a1', 'bogus')).toBe(false);
    expect(await service.checkReverifyToken('a1', undefined)).toBe(false);
  });

  it('validate2fa：備用碼可用且一次性消耗（再用同碼失敗）', async () => {
    const secret = generateTotpSecret();
    const { plain, hashed } = generateRecoveryCodes();
    const { service, state } = setup([
      {
        id: 'a1',
        role: 'ADMIN',
        username: 'admin',
        totpEnabled: true,
        totpSecretEnc: encryptSecret(secret),
        recoveryCodes: JSON.stringify(hashed),
      },
    ]);
    const code = plain[0]!;
    const res = await service.validate2fa('a1', code);
    expect(res.reverifyToken.length).toBeGreaterThan(10);
    // 已消耗：清單少一組
    const u = state.users.find((x) => x.id === 'a1')!;
    expect(JSON.parse(u.recoveryCodes!)).toHaveLength(9);
    // 再次使用同一備用碼 → 失敗
    await expect(service.validate2fa('a1', code)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('reverify：正確 TOTP → token；同碼重用 → Unauthorized（防重用）', async () => {
    const { user, secret } = enableTotp({ id: 'a1', username: 'admin' });
    const { service } = setup([user]);
    const code = currentTotp(secret);
    const res = await service.reverify('a1', code);
    expect(res.reverifyToken.length).toBeGreaterThan(10);
    await expect(service.reverify('a1', code)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('未啟用 2FA → validate / reverify 皆 Forbidden', async () => {
    const { service } = setup([{ id: 'a1', role: 'ADMIN', username: 'admin' }]);
    await expect(service.validate2fa('a1', '123456')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.reverify('a1', '123456')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ═════════════════ 玩家管理 ═════════════════

describe('admin.service: 玩家查詢', () => {
  it('listPlayers：banned 過濾 + 分頁', async () => {
    const { service } = setup([
      { id: 'u1', username: 'alice', banned: false },
      { id: 'u2', username: 'bob', banned: true },
      { id: 'u3', username: 'carol', banned: true },
    ]);
    const all = await service.listPlayers({ page: 1, limit: 20 });
    expect(all.total).toBe(3);
    const banned = await service.listPlayers({ page: 1, limit: 20, banned: true });
    expect(banned.total).toBe(2);
    expect(banned.items.every((i) => i.banned)).toBe(true);
    expect(banned.items[0]!.balance).toBe('1000'); // BigInt → string
  });

  it('listPlayers：username 模糊搜尋', async () => {
    const { service } = setup([
      { id: 'u1', username: 'alice' },
      { id: 'u2', username: 'alicia' },
      { id: 'u3', username: 'bob' },
    ]);
    const res = await service.listPlayers({ page: 1, limit: 20, q: 'ali' });
    expect(res.items).toHaveLength(2);
  });

  it('getPlayer：回傳詳情 + 近期登入；不存在 → NotFound', async () => {
    const { service, state } = setup([{ id: 'u1', username: 'alice' }]);
    state.loginLogs.push({ userId: 'u1', result: 'SUCCESS', ip: '1.2.3.4', createdAt: new Date() });
    const detail = await service.getPlayer('u1');
    expect(detail.username).toBe('alice');
    expect(detail.recentLogins).toHaveLength(1);
    await expect(service.getPlayer('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('admin.service: 封鎖 / 禁言', () => {
  it('setBan：封鎖 → 更新欄位 + 撤銷會話 + 踢線 + 稽核', async () => {
    const { service, state, disconnectUser, hmacRevoke } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'bob' },
    ]);
    state.refreshTokens.push({ id: 'rt1', userId: 'u1', revoked: false });

    const res = await service.setBan('admin1', 'u1', true, '9.9.9.9', '違規');
    expect(res.banned).toBe(true);
    expect(state.users.find((u) => u.id === 'u1')!.banned).toBe(true);
    expect(state.refreshTokens[0]!.revoked).toBe(true);
    expect(disconnectUser).toHaveBeenCalledWith('u1');
    expect(hmacRevoke).toHaveBeenCalledWith('u1');
    const audit = state.auditLogs.find((a) => a['action'] === AUDIT_ACTIONS.BAN_USER)!;
    expect(audit).toBeDefined();
    expect((audit['after'] as Row)['banned']).toBe(true);
  });

  it('setBan：不可封鎖管理員 / 自己', async () => {
    const { service } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'admin2', role: 'ADMIN', username: 'admin2' },
    ]);
    await expect(service.setBan('admin1', 'admin2', true, 'ip')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.setBan('admin1', 'admin1', true, 'ip')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('setBan：解封不踢線；setMute 設定時長記錄 mutedUntil', async () => {
    const { service, state, disconnectUser } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'bob', banned: true },
    ]);
    await service.setBan('admin1', 'u1', false, 'ip');
    expect(state.users.find((u) => u.id === 'u1')!.banned).toBe(false);
    expect(disconnectUser).not.toHaveBeenCalled();

    const mute = await service.setMute('admin1', 'u1', true, 'ip', { durationMinutes: 30 });
    expect(mute.muted).toBe(true);
    expect(mute.mutedUntil).not.toBeNull();
    expect(state.users.find((u) => u.id === 'u1')!.muted).toBe(true);
    expect(state.auditLogs.some((a) => a['action'] === AUDIT_ACTIONS.MUTE_USER)).toBe(true);
  });
});

describe('admin.service: 手動調幣', () => {
  it('正向調整 → 走 wallet.credit，餘額增加 + 稽核 + ADMIN_ADJUST 交易', async () => {
    const { service, state } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'bob', balance: 1000n },
    ]);
    const res = await service.adjustBalance('admin1', 'u1', 500, '補償', '1.1.1.1');
    expect(res.newBalance).toBe('1500');
    expect(res.delta).toBe('500');
    expect(state.users.find((u) => u.id === 'u1')!.balance).toBe(1500n);
    expect(state.txRecords.some((t) => t['type'] === 'ADMIN_ADJUST' && t['delta'] === 500n)).toBe(
      true,
    );
    const audit = state.auditLogs.find((a) => a['action'] === AUDIT_ACTIONS.ADJUST_BALANCE)!;
    expect((audit['before'] as Row)['balance']).toBe('1000');
    expect((audit['after'] as Row)['balance']).toBe('1500');
  });

  it('負向調整 → 走 wallet.debit，餘額減少', async () => {
    const { service, state } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'bob', balance: 1000n },
    ]);
    const res = await service.adjustBalance('admin1', 'u1', -300, '回收', 'ip');
    expect(res.newBalance).toBe('700');
    expect(state.users.find((u) => u.id === 'u1')!.balance).toBe(700n);
  });

  it('餘額不足 → InsufficientBalance 且整筆回滾（無稽核、餘額不變）', async () => {
    const { service, state } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'bob', balance: 100n },
    ]);
    await expect(service.adjustBalance('admin1', 'u1', -500, '回收', 'ip')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(state.users.find((u) => u.id === 'u1')!.balance).toBe(100n); // 回滾
    expect(state.auditLogs).toHaveLength(0); // 稽核也回滾
    expect(state.txRecords).toHaveLength(0);
  });

  it('調幣目標不存在 → NotFound', async () => {
    const { service } = setup([{ id: 'admin1', role: 'ADMIN', username: 'admin' }]);
    await expect(service.adjustBalance('admin1', 'ghost', 100, 'x', 'ip')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ═════════════════ 公告 / Gift Code / 稽核 ═════════════════

describe('admin.service: 公告', () => {
  it('createAnnouncement：立即生效 → 廣播 + 稽核；getActive 過濾窗口', async () => {
    const { service, state, emitAnnouncement } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
    ]);
    const created = await service.createAnnouncement(
      'admin1',
      { title: '維護公告', content: '今晚維護' },
      'ip',
    );
    expect(created.active).toBe(true);
    expect(emitAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, title: '維護公告' }),
    );
    expect(state.auditLogs.some((a) => a['action'] === AUDIT_ACTIONS.CREATE_ANNOUNCEMENT)).toBe(
      true,
    );

    // 加一筆未來生效（不應出現在 active）
    await service.createAnnouncement(
      'admin1',
      {
        title: '未來',
        content: '尚未開始',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'ip',
    );
    const active = await service.getActiveAnnouncements();
    expect(active.items).toHaveLength(1);
    expect(active.items[0]!.title).toBe('維護公告');
  });

  it('update / delete 公告 + 稽核；不存在 → NotFound', async () => {
    const { service, state } = setup([{ id: 'admin1', role: 'ADMIN', username: 'admin' }]);
    const created = await service.createAnnouncement('admin1', { title: 'A', content: 'B' }, 'ip');
    const updated = await service.updateAnnouncement('admin1', created.id, { title: 'A2' }, 'ip');
    expect(updated.title).toBe('A2');
    await service.deleteAnnouncement('admin1', created.id, 'ip');
    expect(state.announcements).toHaveLength(0);
    await expect(
      service.updateAnnouncement('admin1', 'ghost', { title: 'x' }, 'ip'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('admin.service: Gift Code 與稽核日誌', () => {
  it('createGiftCode：回傳明文碼 + 稽核；列表遮蔽為 ****', async () => {
    const { service, state } = setup([{ id: 'admin1', role: 'ADMIN', username: 'admin' }]);
    const gc = await service.createGiftCode(
      'admin1',
      { amount: 500, maxUses: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      'ip',
    );
    expect(gc.code.length).toBeGreaterThanOrEqual(16);
    expect(gc.amount).toBe('500');
    expect(state.auditLogs.some((a) => a['action'] === AUDIT_ACTIONS.CREATE_GIFT_CODE)).toBe(true);

    const list = await service.listGiftCodes({ page: 1, limit: 20 });
    expect(list.items[0]!.code).toBe('****');
  });

  it('createGiftCode：過期時間非未來 → 驗證錯誤', async () => {
    const { service } = setup([{ id: 'admin1', role: 'ADMIN', username: 'admin' }]);
    await expect(
      service.createGiftCode(
        'admin1',
        { amount: 1, maxUses: 1, expiresAt: new Date(Date.now() - 1000).toISOString() },
        'ip',
      ),
    ).rejects.toThrow();
  });

  it('listAuditLogs：解析 admin/target 名稱 + action 過濾', async () => {
    const { service } = setup([
      { id: 'admin1', role: 'ADMIN', username: 'superadmin' },
      { id: 'u1', username: 'victim', balance: 1000n },
    ]);
    await service.adjustBalance('admin1', 'u1', 100, 'test', 'ip');
    const all = await service.listAuditLogs({ page: 1, limit: 50 });
    expect(all.total).toBe(1);
    expect(all.items[0]!.adminUsername).toBe('superadmin');
    expect(all.items[0]!.targetUsername).toBe('victim');

    const filtered = await service.listAuditLogs({
      page: 1,
      limit: 50,
      action: AUDIT_ACTIONS.BAN_USER,
    });
    expect(filtered.total).toBe(0);
  });
});

// ═════════════════ 限時禁言自動解除（releaseTimedMute）═════════════════

describe('admin.service: 限時禁言自動解除', () => {
  function setupWithSchedule(seedUsers: Array<Partial<FakeUser> & { id: string }>) {
    const { client, state } = createFakeDb(seedUsers);
    const { redis, store } = createFakeRedis();
    const prisma = client as unknown as PrismaClient;
    const scheduleTimedUnmute = vi.fn();
    const service = createAdminService({
      prisma,
      redis,
      wallet: createWalletService(prisma),
      scheduleTimedUnmute,
    });
    return { service, state, store, scheduleTimedUnmute };
  }

  it('setMute 限時 → 排程到期解除 + 寫 Redis 期限標記（值＝mutedUntil）', async () => {
    const { service, store, scheduleTimedUnmute } = setupWithSchedule([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'u1' },
    ]);
    const res = await service.setMute('admin1', 'u1', true, 'ip', { durationMinutes: 5 });
    expect(res.mutedUntil).not.toBeNull();
    expect(scheduleTimedUnmute).toHaveBeenCalledWith('u1', res.mutedUntil, 5 * 60_000);
    expect(store.get('admin:mute:until:u1')).toBe(res.mutedUntil);
  });

  it('setMute 永久（無時長）→ 不排程，且清除既有期限標記（防舊到期任務誤解永久禁言）', async () => {
    const { service, store, scheduleTimedUnmute } = setupWithSchedule([
      { id: 'admin1', role: 'ADMIN', username: 'admin' },
      { id: 'u1', username: 'u1' },
    ]);
    store.set('admin:mute:until:u1', '2099-01-01T00:00:00.000Z'); // 先前的限時標記
    await service.setMute('admin1', 'u1', true, 'ip', {});
    expect(scheduleTimedUnmute).not.toHaveBeenCalled();
    expect(store.has('admin:mute:until:u1')).toBe(false);
  });

  it('releaseTimedMute：標記相符 → 解除 + 稽核 UNMUTE_USER（行為者 SYSTEM）+ 清標記', async () => {
    const { service, state, store } = setupWithSchedule([{ id: 'u1', username: 'u1', muted: true }]);
    store.set('admin:mute:until:u1', 'T1');
    const r = await service.releaseTimedMute('u1', 'T1');
    expect(r.released).toBe(true);
    expect(state.users.find((u) => u.id === 'u1')!.muted).toBe(false);
    expect(store.has('admin:mute:until:u1')).toBe(false);
    const audit = state.auditLogs.find((a) => a['action'] === AUDIT_ACTIONS.UNMUTE_USER)!;
    expect(audit).toBeDefined();
    expect(audit['adminId']).toBe('SYSTEM');
  });

  it('releaseTimedMute：標記不符（已被新禁言/永久禁言取代）→ 不解除、保持禁言', async () => {
    const { service, state, store } = setupWithSchedule([{ id: 'u1', username: 'u1', muted: true }]);
    store.set('admin:mute:until:u1', 'T2');
    const r = await service.releaseTimedMute('u1', 'T1');
    expect(r.released).toBe(false);
    expect(state.users.find((u) => u.id === 'u1')!.muted).toBe(true);
  });

  it('releaseTimedMute：標記不存在（已手動解禁）→ 不解除', async () => {
    const { service, state } = setupWithSchedule([{ id: 'u1', username: 'u1', muted: true }]);
    const r = await service.releaseTimedMute('u1', 'T1');
    expect(r.released).toBe(false);
    expect(state.users.find((u) => u.id === 'u1')!.muted).toBe(true);
  });
});
