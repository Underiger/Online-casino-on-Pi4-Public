/**
 * Auth 模組 DTO（zod schema + 推導型別）。
 * M05 規格凍結時遷移至 packages/shared/dto 供前端共用。
 */
import { z } from 'zod';

// ── 請求 schema ──────────────────────────────────────────────

export const RegisterSchema = z.object({
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,20}$/, '使用者名稱須為 3–20 字元的英數或底線'),
  password: z
    .string()
    .min(8, '密碼至少 8 字元')
    .max(72, '密碼最長 72 字元'),
});

export const LoginSchema = z.object({
  username: z.string().min(1, '請輸入使用者名稱').max(20),
  password: z.string().min(1, '請輸入密碼').max(72),
});

// refresh token 為 randomBytes(64).toString('hex') → 恰 128 hex 字元
export const RefreshSchema = z.object({
  refreshToken: z.string().regex(/^[0-9a-f]{128}$/, 'refresh token 格式錯誤'),
});

export const LogoutSchema = RefreshSchema;

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;

// ── 回應型別（鏡像 packages/shared dto/auth.dto.ts；backend 不 import shared） ──

/** 鏡像 @casino/shared AuthUserInfo */
export interface AuthUserInfo {
  id: string;
  username: string;
  role: 'PLAYER' | 'ADMIN';
  balance: string; // BigInt → string
  avatarId: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** access token 壽命（秒） */
  expiresIn: number;
  /**
   * HMAC 會話金鑰（base64url，M06；02_TDD §5.2）。
   * 僅經 TLS 登入/refresh 回應下發一次；前端存 Pinia 記憶體，不落 localStorage。
   * 開發模式 Redis 未啟動時為空字串（hmac-guard 同步跳過驗證）。
   */
  hmacKey: string;
}

/** register / login 回應：鏡像 @casino/shared RegisterRes / LoginRes（皆 = AuthTokens & { user }） */
export interface RegisterResult extends TokenPair {
  user: AuthUserInfo;
}

/** 寫入 LoginLog 用的請求中繼資料 */
export interface ClientMeta {
  ip: string;
  userAgent: string;
}
