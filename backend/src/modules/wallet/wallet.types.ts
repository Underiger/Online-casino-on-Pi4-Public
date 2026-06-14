/**
 * Wallet 模組 DTO（與 docs/04_API_SPEC.md §3.3、packages/shared dto/wallet.dto.ts 對齊）。
 *
 * 金額一律 BigInt（最小單位 1 Coin，全系統禁止浮點——03_DATABASE_DESIGN 全域約定）；
 * HTTP 回應序列化為字串（M05 §1.6 BigInt 序列化規範）。
 */
import { z } from 'zod';
import { TxType, type Prisma } from '@prisma/client';

// ── 請求 schema ──────────────────────────────────────────────

export const TxListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.nativeEnum(TxType).optional(),
});
export type TxListQuery = z.infer<typeof TxListQuerySchema>;

// ── service 介面型別 ─────────────────────────────────────────

/** debit / credit 共用選項 */
export interface WalletMutateOptions {
  /** 關聯單據：BetRecord / GiftCode / AdminAuditLog 的 id */
  refId?: string;
  /** 備註（≤200 字，admin 手動調整用） */
  memo?: string;
  /**
   * 既有交易客戶端：遊戲結算（如 slot spin）需在「單一 PG 交易」內
   * 完成扣款 → BetRecord → 賠付（02_TDD §4 關鍵存取模式），
   * 由呼叫方開交易並傳入；未傳入時 wallet 自行包 $transaction。
   */
  tx?: Prisma.TransactionClient;
}

/** 異動結果：餘額為異動後值，呼叫方（前端）一律以此覆蓋顯示 */
export interface WalletMutationResult {
  /** 異動後餘額 */
  balance: bigint;
  /** 異動後樂觀鎖版本 */
  version: number;
  /** 本筆 BalanceTransaction.id（可作後續單據 refId） */
  transactionId: string;
}

export interface BalanceResult {
  balance: bigint;
  version: number;
}

export interface TxRecordItem {
  id: string;
  type: TxType;
  delta: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  refId: string | null;
  memo: string | null;
  createdAt: Date;
}

export interface TxListResult {
  items: TxRecordItem[];
  total: number;
  page: number;
  limit: number;
}
