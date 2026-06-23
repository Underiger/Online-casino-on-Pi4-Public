/**
 * Admin 模組 DTO（zod schema + 回應型別；M21）。
 *
 * ⚠ 鏡像 packages/shared/src/dto/admin.dto.ts——backend tsconfig rootDir=src 於 NodeNext
 *   下無法直接 import shared 的 .ts 入口（既有專案鐵律），故各欄位以 admin.dto 為準在此複製。
 *
 * 2FA 重驗採「reverifyToken」流：高危操作（調幣 / 封鎖 / 產 Gift Code）的請求 **不** 內嵌
 * totpCode，而是先呼叫 POST /api/admin/totp/reverify 取得短效 reverifyToken，再以
 * `x-reverify-token` 標頭夾帶（admin.routes 的 requireReverify preHandler 驗證）。
 * 此設計與 shared admin.dto 早期凍結的「inline totpCode」草案不同；admin 前端（M22）
 * 對接時一併更新 shared 契約。
 */
import { z } from 'zod';
import type { Role } from '@prisma/client';

/** AdminAuditLog.action 欄位字元上限（鏡像 shared AUDIT_ACTION_MAX_LENGTH） */
export const AUDIT_ACTION_MAX_LENGTH = 40;
/** 單次調幣量上限（保持在 Number 安全整數內，且為合理上限） */
export const ADJUST_BALANCE_ABS_MAX = 1_000_000_000;

// ─────────────────────────── 2FA / TOTP ───────────────────────────

/** POST /totp/verify（確認綁定）：輸入剛產生的 6 位 TOTP */
export const TotpConfirmReqSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type TotpConfirmReq = z.infer<typeof TotpConfirmReqSchema>;

/** POST /totp/validate（登入後 2FA）：TOTP 或備用碼 */
export const TotpValidateReqSchema = z.object({
  code: z.string().min(6).max(32),
});
export type TotpValidateReq = z.infer<typeof TotpValidateReqSchema>;

/** POST /totp/reverify（高危操作步進驗證）：僅接受即時 TOTP */
export const TotpReverifyReqSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'TOTP 為 6 位數字'),
});
export type TotpReverifyReq = z.infer<typeof TotpReverifyReqSchema>;

export interface TotpSetupRes {
  /** otpauth:// URI，用於 QR Code 顯示 */
  qrUri: string;
  /** Base32 secret，給無法掃碼者手動輸入（僅此一次） */
  secret: string;
}

export interface TotpConfirmRes {
  enabled: boolean;
  /** 10 組一次性備用碼，僅此一次顯示 */
  recoveryCodes: string[];
}

export interface ReverifyRes {
  reverifyToken: string;
  /** 秒 */
  expiresIn: number;
}

export interface ValidateRes {
  reverifyToken: string;
  expiresIn: number;
}

export interface AdminMeRes {
  userId: string;
  username: string;
  role: Role;
  totpEnabled: boolean;
  /** Telegram 2FA 推播是否已設定（TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID 皆非空） */
  telegramEnabled: boolean;
}

/** POST /totp/reverify-telegram：發送 Telegram 核准推播 */
export interface TelegramReverifyStartRes {
  requestId: string;
  /** 秒；逾時未回應視為過期 */
  expiresIn: number;
}

/**
 * GET /totp/reverify-telegram/:requestId：前端輪詢用。
 * 'expired' 涵蓋「請求不存在」（從未建立 / TTL 已過）；查詢別人的 requestId
 * 視為越權，直接拋 NotFoundError（HTTP 404），不透過這個型別表達。
 */
export interface TelegramReverifyStatusRes {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** status==='approved' 時附帶 */
  reverifyToken?: string;
}

// ─────────────────────────── 玩家管理 ───────────────────────────

export const PlayerSearchQuerySchema = z.object({
  q: z.string().max(40).optional(),
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

export interface AdminLoginLogItem {
  result: string;
  ip: string;
  createdAt: string;
}

export interface AdminPlayerDetailRes extends AdminPlayerItem {
  totpEnabled: boolean;
  lastDailyAt: string | null;
  updatedAt: string;
  recentLogins: AdminLoginLogItem[];
}

/** 高危：手動調整餘額（reverifyToken 由標頭夾帶） */
export const AdjustBalanceReqSchema = z.object({
  delta: z
    .number()
    .int('調整量必須為整數')
    .gte(-ADJUST_BALANCE_ABS_MAX)
    .lte(ADJUST_BALANCE_ABS_MAX)
    .refine((v) => v !== 0, '調整量不可為零'),
  reason: z.string().min(1, '請填寫調整原因').max(180),
});
export type AdjustBalanceReq = z.infer<typeof AdjustBalanceReqSchema>;

export interface AdjustBalanceRes {
  newBalance: string;
  delta: string;
}

/** 封鎖 / 解封（高危）；banned 由 /ban 與 /unban 端點決定，body 僅選填原因 */
export const BanReqSchema = z.object({
  reason: z.string().max(180).optional(),
});
export type BanReq = z.infer<typeof BanReqSchema>;

export interface BanUserRes {
  userId: string;
  banned: boolean;
}

/** 禁言 / 解除禁言；durationMinutes 選填（缺省＝永久，直到手動解除） */
export const MuteReqSchema = z.object({
  durationMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  reason: z.string().max(180).optional(),
});
export type MuteReq = z.infer<typeof MuteReqSchema>;

export interface MuteUserRes {
  userId: string;
  muted: boolean;
  /** 設定了時長時的到期 ISO 時間（純記錄；自動解除由後續排程實作） */
  mutedUntil: string | null;
}

// ─────────────────────────── Gift Code（高危） ───────────────────────────

export const CreateGiftCodeReqSchema = z.object({
  amount: z.number().int().positive().max(ADJUST_BALANCE_ABS_MAX),
  charmId: z.string().optional(),
  maxUses: z.number().int().min(1).max(100000).default(1),
  expiresAt: z.string().datetime({ message: 'expiresAt 必須為 ISO 8601 格式' }),
});
export type CreateGiftCodeReq = z.infer<typeof CreateGiftCodeReqSchema>;

export interface GiftCodeItem {
  id: string;
  /** 建立後僅顯示一次；列表查詢遮蔽為 '****' */
  code: string;
  amount: string; // BigInt → string
  charmId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
}

export const GiftCodeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type GiftCodeListQuery = z.infer<typeof GiftCodeListQuerySchema>;

export interface GiftCodeListRes {
  items: GiftCodeItem[];
  total: number;
  page: number;
  limit: number;
}

// ─────────────────────────── 公告管理 ───────────────────────────

export const AnnouncementCreateReqSchema = z.object({
  title: z.string().min(1).max(60),
  content: z.string().min(1).max(500),
  active: z.boolean().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});
export type AnnouncementCreateReq = z.infer<typeof AnnouncementCreateReqSchema>;

export const AnnouncementUpdateReqSchema = AnnouncementCreateReqSchema.partial();
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

export const AuditQuerySchema = z.object({
  adminId: z.string().optional(),
  action: z.string().max(AUDIT_ACTION_MAX_LENGTH).optional(),
  targetUserId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export interface AuditItem {
  id: string;
  adminId: string;
  adminUsername: string | null;
  action: string;
  targetUserId: string | null;
  targetUsername: string | null;
  before: unknown;
  after: unknown;
  ip: string;
  createdAt: string;
}

export interface AuditListRes {
  items: AuditItem[];
  total: number;
  page: number;
  limit: number;
}
