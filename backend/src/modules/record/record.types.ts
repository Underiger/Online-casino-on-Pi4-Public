/**
 * 管理後台紀錄查詢 DTO（M22；02_TDD §5.7）。
 *
 * 涵蓋三類紀錄：LoginLog / BetRecord / BalanceTransaction。
 * 分頁回應格式統一：{ data, total, page, totalPages }。
 */
import { z } from 'zod';

// ─── 共用分頁基底 ─────────────────────────────────────────────────────────────

const pageBase = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// ─── 登入紀錄 ─────────────────────────────────────────────────────────────────

export const LoginRecordQuerySchema = z.object({
  userId: z.string().optional(),
  result: z.enum(['SUCCESS', 'WRONG_PASSWORD', 'BANNED', 'TOTP_FAILED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  ...pageBase,
});
export type LoginRecordQuery = z.infer<typeof LoginRecordQuerySchema>;

export interface LoginLogItem {
  id: string;
  userId: string | null;
  username: string;
  ip: string;
  userAgent: string;
  result: string;
  createdAt: string;
}

// ─── 下注紀錄 ─────────────────────────────────────────────────────────────────

export const BetRecordQuerySchema = z.object({
  userId: z.string().optional(),
  gameType: z.enum(['SLOT', 'ROULETTE']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  ...pageBase,
});
export type BetRecordQuery = z.infer<typeof BetRecordQuerySchema>;

export interface BetRecordItem {
  id: string;
  userId: string;
  gameType: string;
  amount: string;
  payout: string;
  detail: unknown;
  roundId: string | null;
  createdAt: string;
}

// ─── 交易紀錄 ─────────────────────────────────────────────────────────────────

export const TxRecordQuerySchema = z.object({
  userId: z.string().optional(),
  type: z
    .enum(['BET', 'PAYOUT', 'DAILY_REWARD', 'TASK_REWARD', 'GIFT_CODE', 'ADMIN_ADJUST', 'JACKPOT', 'REFUND'])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  ...pageBase,
});
export type TxRecordQuery = z.infer<typeof TxRecordQuerySchema>;

export interface TxRecordItem {
  id: string;
  userId: string;
  type: string;
  delta: string;
  balanceBefore: string;
  balanceAfter: string;
  refId: string | null;
  memo: string | null;
  createdAt: string;
}

// ─── 通用分頁回應 ─────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}
