import { z } from 'zod';
import { SlotSymbol } from '../enums';
import { SLOT_BET_AMOUNTS } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * POST /api/slot/spin 請求 body。
 * HMAC 簽章欄位（sig/nonce/ts/seq）透過 HTTP headers 傳遞：
 *   x-sig / x-nonce / x-ts / x-seq
 */
export const SpinReqSchema = z.object({
  betAmount: z.union([
    z.literal(SLOT_BET_AMOUNTS[0]),
    z.literal(SLOT_BET_AMOUNTS[1]),
    z.literal(SLOT_BET_AMOUNTS[2]),
  ]),
});
export type SpinReq = z.infer<typeof SpinReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

/** 三軸各一符號的結果 tuple */
export type SlotReels = [SlotSymbol, SlotSymbol, SlotSymbol];

export interface SpinRes {
  betRecordId: string;
  betAmount: number;
  reels: SlotReels;
  /** 0 表示本次未中獎 */
  payout: number;
  newBalance: string;      // BigInt → string
  pityActive: boolean;     // 本次旋轉保底加成是否生效
  pityCounter: number;     // 旋轉後的保底計數
  jackpotTriggered: boolean;
  /** M14 擴充：觸發且派彩成功時的派彩金額（BigInt → string）；其餘為 null */
  jackpotPayout: string | null;
  jackpotPoints: number;   // 旋轉後的累積點數
  /** 今日幸運符號（用於前端顯示加成標記） */
  luckySymbol: SlotSymbol | null;
  serverSeedHash: string;  // 供 provably-fair 驗證（日後公開 seed）
}

export interface PaytableEntry {
  symbol: SlotSymbol;
  tripleMultiplier: number;
  doubleMultiplier: number | null; // null 表示無二連賠付
  isWild: boolean;
}

export interface SlotPaytableRes {
  entries: PaytableEntry[];
  luckySymbol: SlotSymbol | null;
  luckyMultiplierBonus: number; // 額外賠率倍數，通常 1.5
}

export interface SlotHistoryQuery {
  page?: number;
  limit?: number;
}

export interface SlotHistoryItem {
  id: string;
  betAmount: number;
  reels: SlotReels;
  payout: number;
  jackpotTriggered: boolean;
  createdAt: string;
}

export interface SlotHistoryRes {
  items: SlotHistoryItem[];
  total: number;
  page: number;
  limit: number;
}
