import { z } from 'zod';
import { CharmRarity, CharmType } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

/** 抽取次數：1（單抽）或 10（十連抽） */
export const GachaPullReqSchema = z.object({
  count: z.union([z.literal(1), z.literal(10)]),
});
export type GachaPullReq = z.infer<typeof GachaPullReqSchema>;

// ── Pull response ──────────────────────────────────────────────────────────────

/** 單筆抽取結果 */
export interface GachaDraw {
  charmId: string;
  code: string;
  name: string;
  description: string;
  type: CharmType;
  rarity: CharmRarity;
  /** false = 重複（已擁有），改為退幣 */
  isNew: boolean;
  /** 重複時退還的 Coin（字串；新護符為 "0"） */
  refund: string;
}

export interface GachaPullRes {
  /** 單抽長度 1；十連長度 10 */
  results: GachaDraw[];
  /** 本次花費（字串） */
  cost: string;
  /** 重複轉換回饋總額（字串） */
  totalRefund: string;
  newBalance: string;
  /** 本次是否抽到新護符 */
  grantedNew: boolean;
}

// ── Catalog response ─────────────────────────────────────────────────────────

export interface GachaCatalogItem {
  id: string;
  code: string;
  name: string;
  description: string;
  type: CharmType;
  rarity: CharmRarity;
  /** 玩家是否已擁有 */
  owned: boolean;
}

export interface GachaRarityInfo {
  rarity: CharmRarity;
  /** 抽中機率（百分比字串，如 "60.0"） */
  rate: string;
  /** 重複轉換回饋（Coin 字串） */
  dupRefund: string;
}

export interface GachaCatalogRes {
  singleCost: number;
  tenCost: number;
  tenPullCount: number;
  floorRarity: CharmRarity;
  rarities: GachaRarityInfo[];
  pool: GachaCatalogItem[];
  ownedCount: number;
  totalCount: number;
}
