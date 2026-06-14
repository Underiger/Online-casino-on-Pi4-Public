/**
 * Auth 模組 service（02_TDD §5.4）。
 *
 * 設計：
 * - 密碼：argon2id（預設參數 m=65536, t=3, p=4）。
 * - Access Token：JWT HS256，15 分鐘（簽發函式由外部注入，方便測試與共用 @fastify/jwt）。
 * - Refresh Token：crypto.randomBytes(64).hex（128 字元不透明串），DB 只存 sha256(token)；
 *   旋轉式——每次 refresh 以「條件更新搶占」廢舊發新（updateMany where revoked=false，
 *   檢查 count===1，與餘額扣款同模式），並發重放只有一個成功。
 * - 重用偵測：拿「已撤銷」的 token 來 refresh = 旋轉鏈分叉（token 可能已外洩），
 *   立即撤銷整個 familyId 家族並回 403，強制重新登入。
 * - LoginLog：成功/密碼錯誤/封鎖 一律落庫（IP + User-Agent）。
 * - HMAC 金鑰（M06，02_TDD §5.2）：登入/refresh 皆輪換會話金鑰並隨回應下發
 *   （rotate 保留舊金鑰 30s 寬限）；logout 即刻撤銷。金鑰存 Redis，單鍵每使用者——
 *   多裝置登入會使前一裝置簽章失效（設計取捨，前一裝置 refresh 後自動恢復）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma, type PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../../shared/errors.js';
import type { JwtPayload } from '../../plugins/auth.js';
import type { HmacKeyStore } from '../../security/hmac.js';
import { createUserService } from '../user/user.service.js';
import type {
  ClientMeta,
  LoginInput,
  RegisterInput,
  RegisterResult,
  TokenPair,
} from './auth.types.js';

// ═════════════════ 純函式（單元測試直接覆蓋） ═════════════════

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // 雜湊格式損毀等異常一律視為驗證失敗，不洩漏原因
    return false;
  }
}

/** 不透明 refresh token：128 hex 字元 */
export function generateRefreshToken(): string {
  return randomBytes(64).toString('hex');
}

/** DB 僅存 sha256(token)，明文外洩資料庫也無法重放 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** '15m' / '900s' / '2h' / '7d' → 秒數；解析失敗回退 900 */
export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
  return value * factor;
}

export function refreshTokenExpiry(now = new Date()): Date {
  return new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

// ═════════════════ service 工廠（依賴注入） ═════════════════

export interface AuthServiceDeps {
  prisma: PrismaClient;
  /** 由 @fastify/jwt 提供（routes 層注入 app.jwt.sign）；測試注入假實作 */
  signAccessToken: (payload: JwtPayload) => string;
  /** HMAC 會話金鑰管理（routes 層注入 app.hmacKeys）；測試注入假實作 */
  hmacKeys: Pick<HmacKeyStore, 'rotate' | 'revoke'>;
}

export function createAuthService({ prisma, signAccessToken, hmacKeys }: AuthServiceDeps) {
  const users = createUserService(prisma);
  const accessTtlSeconds = ttlToSeconds(env.JWT_ACCESS_TTL);

  /**
   * 協商/輪換 HMAC 金鑰。Redis 不可用：開發模式回空字串續行
   * （hmac-guard 同步跳過驗證），生產模式 fail loud——簽章鏈不可靜默降級。
   */
  async function negotiateHmacKey(userId: string): Promise<string> {
    try {
      return await hmacKeys.rotate(userId);
    } catch (err) {
      if (env.NODE_ENV === 'production') throw err;
      console.warn(
        `auth: redis 不可用，開發模式以空 HMAC 金鑰續行（${(err as Error).message}）`,
      );
      return '';
    }
  }

  /** 撤銷 HMAC 金鑰（登出/封鎖）；失敗不阻斷主流程，金鑰仍會隨 TTL 過期 */
  async function discardHmacKey(userId: string): Promise<void> {
    try {
      await hmacKeys.revoke(userId);
    } catch (err) {
      if (env.NODE_ENV === 'production') throw err;
      console.warn(`auth: redis 不可用，略過 HMAC 金鑰撤銷（${(err as Error).message}）`);
    }
  }

  type LoginResultValue = 'SUCCESS' | 'WRONG_PASSWORD' | 'BANNED' | 'TOTP_FAILED';

  async function writeLoginLog(
    userId: string | null,
    username: string,
    meta: ClientMeta,
    result: LoginResultValue,
  ): Promise<void> {
    await prisma.loginLog.create({
      data: {
        userId,
        username: username.slice(0, 20),
        ip: meta.ip.slice(0, 45),
        userAgent: meta.userAgent.slice(0, 255),
        result,
      },
    });
  }

  /** 撤銷整個旋轉鏈家族（重用偵測 / 登出 / 封鎖） */
  async function revokeFamily(userId: string, familyId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { userId, familyId, revoked: false },
      data: { revoked: true },
    });
  }

  /** 簽發 access + refresh（同 familyId 延續旋轉鏈；登入時開新家族） */
  async function issueTokenPair(
    userId: string,
    role: JwtPayload['role'],
    familyId: string,
  ): Promise<Omit<TokenPair, 'hmacKey'>> {
    const accessToken = signAccessToken({ sub: userId, role });
    const refreshToken = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: refreshTokenExpiry(),
      },
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: accessTtlSeconds };
  }

  return {
    async register({ username, password }: RegisterInput): Promise<RegisterResult> {
      const passwordHash = await hashPassword(password);
      try {
        const user = await users.createPlayer({ username, passwordHash });
        return { userId: user.id, username: user.username };
      } catch (err) {
        // DB unique 約束為準（先查再建有 TOCTOU 競態）
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictError('使用者名稱已被使用');
        }
        throw err;
      }
    },

    async login({ username, password }: LoginInput, meta: ClientMeta): Promise<TokenPair> {
      const user = await users.findByUsername(username);
      if (!user) {
        await writeLoginLog(null, username, meta, 'WRONG_PASSWORD');
        // 帳號不存在與密碼錯誤回同一訊息，不洩漏帳號是否存在
        throw new UnauthorizedError('帳號或密碼錯誤');
      }
      if (user.banned) {
        await writeLoginLog(user.id, username, meta, 'BANNED');
        throw new ForbiddenError('帳號已被封鎖');
      }
      const ok = await verifyPassword(user.passwordHash, password);
      if (!ok) {
        await writeLoginLog(user.id, username, meta, 'WRONG_PASSWORD');
        throw new UnauthorizedError('帳號或密碼錯誤');
      }
      await writeLoginLog(user.id, username, meta, 'SUCCESS');
      // 每次登入開新旋轉鏈家族 + 協商 HMAC 會話金鑰（02_TDD §5.2 步驟 1–3）
      const pair = await issueTokenPair(user.id, user.role as JwtPayload['role'], randomUUID());
      const hmacKey = await negotiateHmacKey(user.id);
      return { ...pair, hmacKey };
    },

    async refresh(rawToken: string): Promise<TokenPair> {
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
      });
      if (!stored) {
        throw new UnauthorizedError('refresh token 無效，請重新登入');
      }

      // ★ 重用偵測：已撤銷的 token 再次出現 = 旋轉鏈分叉，全家族撤銷
      if (stored.revoked) {
        await revokeFamily(stored.userId, stored.familyId);
        throw new ForbiddenError('偵測到 refresh token 重用，所有會話已撤銷，請重新登入');
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        await prisma.refreshToken.updateMany({
          where: { id: stored.id },
          data: { revoked: true },
        });
        throw new UnauthorizedError('refresh token 已過期，請重新登入');
      }

      // 條件更新搶占舊 token：並發 refresh 只有一個贏家，輸家視為重用
      const { count } = await prisma.refreshToken.updateMany({
        where: { id: stored.id, revoked: false },
        data: { revoked: true },
      });
      if (count !== 1) {
        await revokeFamily(stored.userId, stored.familyId);
        throw new ForbiddenError('偵測到 refresh token 重用，所有會話已撤銷，請重新登入');
      }

      const user = await users.findById(stored.userId);
      if (!user || user.banned) {
        await revokeFamily(stored.userId, stored.familyId);
        throw new ForbiddenError('帳號已被封鎖');
      }

      // 延續同一家族（旋轉鏈）；每次 refresh 輪換 HMAC 金鑰（≤24h 自然輪換，舊鑰 30s 寬限）
      const pair = await issueTokenPair(user.id, user.role as JwtPayload['role'], stored.familyId);
      const hmacKey = await negotiateHmacKey(user.id);
      return { ...pair, hmacKey };
    },

    /** 登出：撤銷該 token 所屬的整個家族 + HMAC 金鑰（冪等——token 不存在也視為成功） */
    async logout(rawToken: string): Promise<void> {
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
      });
      if (stored) {
        await revokeFamily(stored.userId, stored.familyId);
        await discardHmacKey(stored.userId); // 後續簽章即刻失效（02_TDD §5.2 輪換節）
      }
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
