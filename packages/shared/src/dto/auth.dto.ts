import { z } from 'zod';
import type { Role } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

export const RegisterReqSchema = z.object({
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,20}$/, '使用者名稱須為 3–20 字元的英數或底線'),
  password: z.string().min(8, '密碼至少 8 字元').max(72, '密碼最長 72 字元'),
});
export type RegisterReq = z.infer<typeof RegisterReqSchema>;

export const LoginReqSchema = z.object({
  username: z.string().min(1, '請輸入使用者名稱').max(20),
  password: z.string().min(1, '請輸入密碼').max(72),
});
export type LoginReq = z.infer<typeof LoginReqSchema>;

/** refreshToken 為 randomBytes(64).hex() → 恰 128 hex 字元 */
export const RefreshReqSchema = z.object({
  refreshToken: z.string().regex(/^[0-9a-f]{128}$/, 'refreshToken 格式錯誤'),
});
export type RefreshReq = z.infer<typeof RefreshReqSchema>;

export const LogoutReqSchema = RefreshReqSchema;
export type LogoutReq = RefreshReq;

// ── Response types ────────────────────────────────────────────────────────────

export interface AuthUserInfo {
  id: string;
  username: string;
  role: Role;
  balance: string;  // BigInt → string
  avatarId: number;
}

/** 每次登入/refresh 均下發新 token 組與 HMAC 金鑰 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;   // access token 壽命（秒）
  /** base64url；前端存於 Pinia 記憶體（不落 localStorage），用於後續下注請求 HMAC 簽章 */
  hmacKey: string;
}

export interface RegisterRes extends AuthTokens {
  user: AuthUserInfo;
}

export interface LoginRes extends AuthTokens {
  user: AuthUserInfo;
}

export interface RefreshRes extends AuthTokens {}

export interface MeRes {
  id: string;
  username: string;
  role: Role;
  balance: string;
  avatarId: number;
  jackpotPoints: number;
  pityCounter: number;
  loginStreak: number;
  muted: boolean;
  flagged: boolean;
  totpEnabled: boolean;
  createdAt: string;
}
