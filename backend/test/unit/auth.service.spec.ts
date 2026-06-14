/**
 * Auth service 單元測試（M04 DoD）。
 *
 * 純函式直接測；service 流程以 in-memory fake prisma 測
 * （旋轉換發、重用偵測全家族撤銷、過期、登出冪等）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  createAuthService,
  generateRefreshToken,
  hashPassword,
  hashToken,
  refreshTokenExpiry,
  ttlToSeconds,
  verifyPassword,
} from '../../src/modules/auth/auth.service.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../../src/shared/errors.js';

// ═════════════════ 純函式 ═════════════════

describe('hashPassword / verifyPassword', () => {
  it('使用 argon2id 並可驗證往返', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
  });

  it('錯誤密碼驗證失敗', async () => {
    const hash = await hashPassword('right-password');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('損毀的雜湊回 false 而非拋錯', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});

describe('refresh token 工具', () => {
  it('generateRefreshToken 為 128 hex 字元且唯一', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).toMatch(/^[0-9a-f]{128}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken 為 sha256 hex（64 字元）且決定性', () => {
    const token = generateRefreshToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateRefreshToken()));
  });

  it('ttlToSeconds 解析各單位，異常回退 900', () => {
    expect(ttlToSeconds('15m')).toBe(900);
    expect(ttlToSeconds('90s')).toBe(90);
    expect(ttlToSeconds('2h')).toBe(7200);
    expect(ttlToSeconds('7d')).toBe(604800);
    expect(ttlToSeconds('banana')).toBe(900);
  });

  it('refreshTokenExpiry 為 REFRESH_TOKEN_TTL_DAYS 天後', () => {
    const now = new Date('2026-06-12T00:00:00Z');
    const expiry = refreshTokenExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(7 * 86_400_000);
  });
});

// ═════════════════ in-memory fake prisma ═════════════════

interface FakeUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  banned: boolean;
}
interface FakeRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  revoked: boolean;
  expiresAt: Date;
}
interface FakeLoginLog {
  userId: string | null;
  username: string;
  ip: string;
  userAgent: string;
  result: string;
}

function createFakeDb() {
  const usersTable: FakeUser[] = [];
  const tokens: FakeRefreshToken[] = [];
  const loginLogs: FakeLoginLog[] = [];
  let seq = 0;

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; username?: string } }) =>
        usersTable.find(
          (u) =>
            (where.id !== undefined && u.id === where.id) ||
            (where.username !== undefined && u.username === where.username),
        ) ?? null,
      create: async ({ data }: { data: { username: string; passwordHash: string } }) => {
        if (usersTable.some((u) => u.username === data.username)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'fake',
          });
        }
        const user: FakeUser = {
          id: `user_${(seq += 1)}`,
          username: data.username,
          passwordHash: data.passwordHash,
          role: 'PLAYER',
          banned: false,
        };
        usersTable.push(user);
        return user;
      },
    },
    refreshToken: {
      create: async ({ data }: { data: Omit<FakeRefreshToken, 'id' | 'revoked'> }) => {
        const row: FakeRefreshToken = { id: `rt_${(seq += 1)}`, revoked: false, ...data };
        tokens.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        tokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; userId?: string; familyId?: string; revoked?: boolean };
        data: { revoked: boolean };
      }) => {
        const matched = tokens.filter(
          (t) =>
            (where.id === undefined || t.id === where.id) &&
            (where.userId === undefined || t.userId === where.userId) &&
            (where.familyId === undefined || t.familyId === where.familyId) &&
            (where.revoked === undefined || t.revoked === where.revoked),
        );
        for (const t of matched) t.revoked = data.revoked;
        return { count: matched.length };
      },
    },
    loginLog: {
      create: async ({ data }: { data: FakeLoginLog }) => {
        loginLogs.push(data);
        return data;
      },
    },
  };

  return { prisma: prisma as unknown as PrismaClient, usersTable, tokens, loginLogs };
}

const META = { ip: '203.0.113.7', userAgent: 'vitest-agent' };

/** M06：記錄 HMAC 金鑰生命週期呼叫的假實作 */
function createFakeHmacKeys() {
  const rotated: string[] = [];
  const revoked: string[] = [];
  return {
    rotated,
    revoked,
    async rotate(userId: string): Promise<string> {
      rotated.push(userId);
      return `hmac-key-${userId}-${rotated.length}`;
    },
    async revoke(userId: string): Promise<void> {
      revoked.push(userId);
    },
  };
}

function makeService(
  db: ReturnType<typeof createFakeDb>,
  hmacKeys = createFakeHmacKeys(),
) {
  return createAuthService({
    prisma: db.prisma,
    signAccessToken: (payload) => `jwt.${payload.sub}.${payload.role}`,
    hmacKeys,
  });
}

// ═════════════════ service 流程 ═════════════════

describe('auth service 流程', () => {
  let db: ReturnType<typeof createFakeDb>;
  let service: ReturnType<typeof makeService>;

  beforeEach(async () => {
    db = createFakeDb();
    service = makeService(db);
    await service.register({ username: 'alice', password: 'password123' });
  });

  it('register：建立玩家並回 userId；重複名稱 → ConflictError', async () => {
    expect(db.usersTable).toHaveLength(1);
    expect(db.usersTable[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(
      service.register({ username: 'alice', password: 'password456' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('login：成功回 token 對並落 SUCCESS log', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    expect(pair.accessToken).toBe(`jwt.${db.usersTable[0]?.id}.PLAYER`);
    expect(pair.refreshToken).toMatch(/^[0-9a-f]{128}$/);
    expect(pair.expiresIn).toBe(900);
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0]?.tokenHash).toBe(hashToken(pair.refreshToken));
    expect(db.loginLogs.at(-1)).toMatchObject({ result: 'SUCCESS', ip: META.ip });
  });

  it('login：密碼錯誤 → 401 並落 WRONG_PASSWORD log', async () => {
    await expect(
      service.login({ username: 'alice', password: 'wrong-password' }, META),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.loginLogs.at(-1)?.result).toBe('WRONG_PASSWORD');
  });

  it('login：帳號不存在 → 401 同樣訊息（不洩漏存在性），log userId 為 null', async () => {
    await expect(
      service.login({ username: 'nobody', password: 'password123' }, META),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.loginLogs.at(-1)).toMatchObject({ result: 'WRONG_PASSWORD', userId: null });
  });

  it('login：封鎖帳號 → 403 並落 BANNED log', async () => {
    db.usersTable[0]!.banned = true;
    await expect(
      service.login({ username: 'alice', password: 'password123' }, META),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.loginLogs.at(-1)?.result).toBe('BANNED');
  });

  it('refresh：旋轉換發——舊 token 撤銷、新 token 同 familyId', async () => {
    const first = await service.login({ username: 'alice', password: 'password123' }, META);
    const second = await service.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(db.tokens).toHaveLength(2);
    expect(db.tokens[0]?.revoked).toBe(true); // 舊的已廢
    expect(db.tokens[1]?.revoked).toBe(false); // 新的有效
    expect(db.tokens[1]?.familyId).toBe(db.tokens[0]?.familyId); // 同旋轉鏈
  });

  it('refresh：重用已撤銷 token → 403 且整個家族撤銷', async () => {
    const first = await service.login({ username: 'alice', password: 'password123' }, META);
    const second = await service.refresh(first.refreshToken); // first 作廢

    // 拿作廢的 first 重放 → 重用偵測
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(ForbiddenError);

    // 全家族（含尚有效的 second）一律撤銷
    expect(db.tokens.every((t) => t.revoked)).toBe(true);
    await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refresh：過期 token → 401 並標記撤銷', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    db.tokens[0]!.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.tokens[0]?.revoked).toBe(true);
  });

  it('refresh：不存在的 token → 401', async () => {
    await expect(service.refresh(generateRefreshToken())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('logout：撤銷整個家族且冪等', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    await service.logout(pair.refreshToken);
    expect(db.tokens.every((t) => t.revoked)).toBe(true);

    // 再次登出與未知 token 登出皆不拋錯
    await expect(service.logout(pair.refreshToken)).resolves.toBeUndefined();
    await expect(service.logout(generateRefreshToken())).resolves.toBeUndefined();
  });

  it('多裝置：不同登入為不同 family，互不影響', async () => {
    const deviceA = await service.login({ username: 'alice', password: 'password123' }, META);
    const deviceB = await service.login({ username: 'alice', password: 'password123' }, META);
    expect(db.tokens[0]?.familyId).not.toBe(db.tokens[1]?.familyId);

    await service.logout(deviceA.refreshToken);
    // device B 不受影響，仍可旋轉
    const rotated = await service.refresh(deviceB.refreshToken);
    expect(rotated.refreshToken).toMatch(/^[0-9a-f]{128}$/);
  });
});

// ═════════════════ HMAC 金鑰生命週期（M06） ═════════════════

describe('HMAC 金鑰協商與輪換', () => {
  let db: ReturnType<typeof createFakeDb>;
  let hmacKeys: ReturnType<typeof createFakeHmacKeys>;
  let service: ReturnType<typeof makeService>;

  beforeEach(async () => {
    db = createFakeDb();
    hmacKeys = createFakeHmacKeys();
    service = makeService(db, hmacKeys);
    await service.register({ username: 'alice', password: 'password123' });
  });

  it('login 協商金鑰並隨回應下發', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    const userId = db.usersTable[0]!.id;
    expect(hmacKeys.rotated).toEqual([userId]);
    expect(pair.hmacKey).toBe(`hmac-key-${userId}-1`);
  });

  it('refresh 輪換新金鑰（每次不同）', async () => {
    const first = await service.login({ username: 'alice', password: 'password123' }, META);
    const second = await service.refresh(first.refreshToken);
    expect(second.hmacKey).not.toBe(first.hmacKey);
    expect(hmacKeys.rotated).toHaveLength(2);
  });

  it('logout 撤銷金鑰；未知 token 登出不觸發撤銷（冪等）', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    await service.logout(pair.refreshToken);
    expect(hmacKeys.revoked).toEqual([db.usersTable[0]!.id]);

    await service.logout(generateRefreshToken());
    expect(hmacKeys.revoked).toHaveLength(1); // 不重複撤銷
  });
});
