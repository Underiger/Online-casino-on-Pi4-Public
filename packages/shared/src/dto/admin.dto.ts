import { z } from 'zod';
import { Role, TxType, GameType } from '../enums';
import { AUDIT_ACTION_MAX_LENGTH } from '../constants';

// ─────────────────────────── Admin 認證 ───────────────────────────

export const AdminLoginReqSchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(1).max(72),
});
export type AdminLoginReq = z.infer<typeof AdminLoginReqSchema>;

/** 第一步回應：帳密正確，需進行 TOTP 驗證 */
export interface AdminLoginStepOneRes {
  /** 短效 token（僅用於第二步 TOTP 驗證，不可作為 API 授權） */
  tempToken: string;
  totpRequired: boolean;
}

export const AdminTotpVerifyReqSchema = z.object({
  tempToken: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type AdminTotpVerifyReq = z.infer<typeof AdminTotpVerifyReqSchema>;

export interface AdminLoginRes {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

// ─────────────────────────── TOTP 管理 ───────────────────────────

export interface AdminTotpSetupRes {
  /** otpauth:// URI，用於 QR Code 顯示 */
  qrUri: string;
  /** Base32 secret，給無法掃碼的情境手動輸入 */
  secret: string;
}

export const AdminTotpConfirmReqSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type AdminTotpConfirmReq = z.infer<typeof AdminTotpConfirmReqSchema>;

export interface AdminTotpConfirmRes {
  enabled: boolean;
  recoveryCodes: string[]; // 10 組，僅顯示一次
}

// ─────────────────────────── 玩家管理 ───────────────────────────

export const PlayerSearchQuerySchema = z.object({
  q: z.string().max(20).optional(),
  banned: z.coerce.boolean().optional(),
  flagged: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PlayerSearchQuery = z.infer<typeof PlayerSearchQuerySchema>;

export interface AdminPlayerItem {
  id: string;
  username: string;
  role: Role;
  balance: string; // BigInt → string
  avatarId: number;
  banned: boolean;
  muted: boolean;
  flagged: boolean;
  jackpotPoints: number;
  loginStreak: number;
  createdAt: string;
}

export interface AdminPlayerListRes {
  items: AdminPlayerItem[];
  total: number;
  page: number;
  limit: number;
}

/** 高危操作：手動調整餘額 — 需逐次 TOTP 重驗 */
export const AdjustBalanceReqSchema = z.object({
  delta: z.number().int().refine((v) => v !== 0, '調整量不可為零'),
  memo: z.string().max(200).optional(),
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type AdjustBalanceReq = z.infer<typeof AdjustBalanceReqSchema>;

export interface AdjustBalanceRes {
  newBalance: string;
  delta: string;
}

/** 封鎖/解封 — 需逐次 TOTP 重驗 */
export const BanUserReqSchema = z.object({
  banned: z.boolean(),
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type BanUserReq = z.infer<typeof BanUserReqSchema>;

export interface BanUserRes {
  banned: boolean;
}

/** 禁言/解除禁言 */
export const MuteUserReqSchema = z.object({
  muted: z.boolean(),
});
export type MuteUserReq = z.infer<typeof MuteUserReqSchema>;

export interface MuteUserRes {
  muted: boolean;
}

// ─────────────────────────── Gift Code 管理 ───────────────────────────

export const AdminCreateGiftCodeReqSchema = z.object({
  amount: z.number().int().positive(),
  charmId: z.string().optional(),
  maxUses: z.number().int().min(1).default(1),
  expiresAt: z.string().datetime({ message: 'expiresAt 必須為 ISO 8601 格式' }),
  totpCode: z.string().regex(/^\d{6}$/),
});
export type AdminCreateGiftCodeReq = z.infer<typeof AdminCreateGiftCodeReqSchema>;

export interface AdminGiftCodeItem {
  id: string;
  /** 建立後僅顯示一次；後續查詢遮蔽為 '****' */
  code: string;
  amount: string; // BigInt → string
  charmId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface AdminGiftCodeListRes {
  items: AdminGiftCodeItem[];
  total: number;
  page: number;
  limit: number;
}

// ─────────────────────────── 紀錄查詢 ───────────────────────────

export const AdminRecordQuerySchema = z.object({
  userId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AdminRecordQuery = z.infer<typeof AdminRecordQuerySchema>;

export const AdminBetRecordQuerySchema = AdminRecordQuerySchema.extend({
  gameType: z.nativeEnum(GameType).optional(),
});
export type AdminBetRecordQuery = z.infer<typeof AdminBetRecordQuerySchema>;

export const AdminTxRecordQuerySchema = AdminRecordQuerySchema.extend({
  type: z.nativeEnum(TxType).optional(),
});
export type AdminTxRecordQuery = z.infer<typeof AdminTxRecordQuerySchema>;

// ─────────────────────────── 公告管理 ───────────────────────────

export const AnnouncementCreateReqSchema = z.object({
  title: z.string().min(1).max(60),
  content: z.string().min(1).max(500),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});
export type AnnouncementCreateReq = z.infer<typeof AnnouncementCreateReqSchema>;

export const AnnouncementUpdateReqSchema = AnnouncementCreateReqSchema.partial().extend({
  active: z.boolean().optional(),
});
export type AnnouncementUpdateReq = z.infer<typeof AnnouncementUpdateReqSchema>;

export interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  active: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

export interface AnnouncementListRes {
  items: AnnouncementItem[];
}

// ─────────────────────────── 稽核日誌 ───────────────────────────

export const AdminAuditQuerySchema = z.object({
  adminId: z.string().optional(),
  action: z.string().max(AUDIT_ACTION_MAX_LENGTH).optional(),
  targetUserId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

export interface AdminAuditItem {
  id: string;
  adminId: string;
  adminUsername: string;
  action: string;
  targetUserId: string | null;
  targetUsername: string | null;
  before: unknown;
  after: unknown;
  ip: string;
  createdAt: string;
}

export interface AdminAuditListRes {
  items: AdminAuditItem[];
  total: number;
  page: number;
  limit: number;
}
