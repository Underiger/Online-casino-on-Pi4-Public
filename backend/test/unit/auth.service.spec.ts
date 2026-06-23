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
  balance: bigint;
  avatarId: number;
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
          balance: 5000n,
          avatarId: 0,
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

/** M06 修復：記錄 seq 門檻重設呼叫的假實作 */
function createFakeReplay() {
  const resetCalls: string[] = [];
  return {
    resetCalls,
    async resetSeq(userId: string): Promise<void> {
      resetCalls.push(userId);
    },
  };
}

function makeService(
  db: ReturnType<typeof createFakeDb>,
  hmacKeys = createFakeHmacKeys(),
  replay = createFakeReplay(),
) {
  return createAuthService({
    prisma: db.prisma,
    signAccessToken: (payload) => `jwt.${payload.sub}.${payload.role}`,
    hmacKeys,
    resetSeq: replay.resetSeq,
  });
}

// ═════════════════ service 流程 ═════════════════

describe('auth service 流程', () => {
  let db: ReturnType<typeof createFakeDb>;
  let service: ReturnType<typeof makeService>;

  beforeEach(async () => {
    db = createFakeDb();
    service = makeService(db);
    await service.register({ username: 'alice', password: 'password123' }, META);
  });

  it('register：建立玩家並回 userId；重複名稱 → ConflictError', async () => {
    expect(db.usersTable).toHaveLength(1);
    expect(db.usersTable[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(
      service.register({ username: 'alice', password: 'password456' }, META),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('login：成功回 token 對並落 SUCCESS log', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    expect(pair.accessToken).toBe(`jwt.${db.usersTable[0]?.id}.PLAYER`);
    expect(pair.refreshToken).toMatch(/^[0-9a-f]{128}$/);
    expect(pair.expiresIn).toBe(900);
    // register（beforeEach）也會發一組 token，故 +1
    expect(db.tokens).toHaveLength(2);
    expect(db.tokens.at(-1)?.tokenHash).toBe(hashToken(pair.refreshToken));
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
    // register（beforeEach）+ login(first) + refresh(second) = 3
    expect(db.tokens).toHaveLength(3);
    const firstRow = db.tokens.find((t) => t.tokenHash === hashToken(first.refreshToken));
    const secondRow = db.tokens.find((t) => t.tokenHash === hashToken(second.refreshToken));
    expect(firstRow?.revoked).toBe(true); // 舊的已廢
    expect(secondRow?.revoked).toBe(false); // 新的有效
    expect(secondRow?.familyId).toBe(firstRow?.familyId); // 同旋轉鏈
  });

  it('refresh：重用已撤銷 token → 403 且整個家族撤銷', async () => {
    const first = await service.login({ username: 'alice', password: 'password123' }, META);
    const second = await service.refresh(first.refreshToken); // first 作廢

    // 拿作廢的 first 重放 → 重用偵測
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(ForbiddenError);

    // 該登入家族（含尚有效的 second）一律撤銷；register（beforeEach）為不同家族，不受影響
    const familyId = db.tokens.find((t) => t.tokenHash === hashToken(first.refreshToken))
      ?.familyId;
    const familyTokens = db.tokens.filter((t) => t.familyId === familyId);
    expect(familyTokens.length).toBeGreaterThan(0);
    expect(familyTokens.every((t) => t.revoked)).toBe(true);
    await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refresh：過期 token → 401 並標記撤銷', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    const row = db.tokens.find((t) => t.tokenHash === hashToken(pair.refreshToken));
    row!.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(row?.revoked).toBe(true);
  });

  it('refresh：不存在的 token → 401', async () => {
    await expect(service.refresh(generateRefreshToken())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('logout：撤銷整個家族且冪等', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    await service.logout(pair.refreshToken);
    const familyId = db.tokens.find((t) => t.tokenHash === hashToken(pair.refreshToken))
      ?.familyId;
    const familyTokens = db.tokens.filter((t) => t.familyId === familyId);
    expect(familyTokens.every((t) => t.revoked)).toBe(true);

    // 再次登出與未知 token 登出皆不拋錯
    await expect(service.logout(pair.refreshToken)).resolves.toBeUndefined();
    await expect(service.logout(generateRefreshToken())).resolves.toBeUndefined();
  });

  it('多裝置：不同登入為不同 family，互不影響', async () => {
    const deviceA = await service.login({ username: 'alice', password: 'password123' }, META);
    const deviceB = await service.login({ username: 'alice', password: 'password123' }, META);
    const rowA = db.tokens.find((t) => t.tokenHash === hashToken(deviceA.refreshToken));
    const rowB = db.tokens.find((t) => t.tokenHash === hashToken(deviceB.refreshToken));
    expect(rowA?.familyId).not.toBe(rowB?.familyId);

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
    await service.register({ username: 'alice', password: 'password123' }, META);
  });

  it('login 協商金鑰並隨回應下發', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    const userId = db.usersTable[0]!.id;
    // register（beforeEach）也會協商一次，故 login 是第 2 次 rotate
    expect(hmacKeys.rotated).toEqual([userId, userId]);
    expect(pair.hmacKey).toBe(`hmac-key-${userId}-2`);
  });

  it('refresh 輪換新金鑰（每次不同）', async () => {
    const first = await service.login({ username: 'alice', password: 'password123' }, META);
    const second = await service.refresh(first.refreshToken);
    expect(second.hmacKey).not.toBe(first.hmacKey);
    // register + login + refresh = 3
    expect(hmacKeys.rotated).toHaveLength(3);
  });

  it('logout 撤銷金鑰；未知 token 登出不觸發撤銷（冪等）', async () => {
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    await service.logout(pair.refreshToken);
    expect(hmacKeys.revoked).toEqual([db.usersTable[0]!.id]);

    await service.logout(generateRefreshToken());
    expect(hmacKeys.revoked).toHaveLength(1); // 不重複撤銷
  });
});

// ═════════════════ Seq 門檻重設（修復跨 session 殘留 ERR_SEQ_REGRESSION） ═════════════════

describe('Seq 門檻重設', () => {
  let db: ReturnType<typeof createFakeDb>;
  let replay: ReturnType<typeof createFakeReplay>;
  let service: ReturnType<typeof makeService>;

  beforeEach(async () => {
    db = createFakeDb();
    replay = createFakeReplay();
    service = makeService(db, createFakeHmacKeys(), replay);
    await service.register({ username: 'alice', password: 'password123' }, META);
  });

  it('register 會重設 seq 門檻（client 端 seq 從 0 起算）', () => {
    const userId = db.usersTable[0]!.id;
    expect(replay.resetCalls).toEqual([userId]);
  });

  it('login 會重設 seq 門檻', async () => {
    const userId = db.usersTable[0]!.id;
    await service.login({ username: 'alice', password: 'password123' }, META);
    // register（beforeEach）+ login，皆是 client 端 seq 真正歸零的時刻
    expect(replay.resetCalls).toEqual([userId, userId]);
  });

  it('refresh 不會重設 seq 門檻——client 端 seq 未歸零，重設會縮短防重放保護窗', async () => {
    const userId = db.usersTable[0]!.id;
    const pair = await service.login({ username: 'alice', password: 'password123' }, META);
    await service.refresh(pair.refreshToken);
    // 仍只有 register + login 兩次，refresh 沒有新增呼叫
    expect(replay.resetCalls).toEqual([userId, userId]);
  });
});
