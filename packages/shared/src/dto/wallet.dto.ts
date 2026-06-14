import { z } from 'zod';
import { TxType } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

export const TxListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.nativeEnum(TxType).optional(),
});
export type TxListQuery = z.infer<typeof TxListQuerySchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface BalanceRes {
  balance: string;  // BigInt → string
  version: number;
}

export interface TxItem {
  id: string;
  type: TxType;
  delta: string;          // BigInt → string（正：收入；負：支出）
  balanceBefore: string;
  balanceAfter: string;
  refId: string | null;   // 關聯 BetRecord / GiftCode / AuditLog id
  memo: string | null;
  createdAt: string;
}

export interface TxListRes {
  items: TxItem[];
  total: number;
  page: number;
  limit: number;
}
