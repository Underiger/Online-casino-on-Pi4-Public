// ── Response types ────────────────────────────────────────────────────────────

export interface JackpotPoolRes {
  /** 持久真值（DB）+ Redis 未落庫增量的合計 */
  pool: string; // BigInt → string
  updatedAt: string;
}

export interface JackpotHistoryItem {
  id: string;
  userId: string;
  username: string;
  avatarId: number;
  poolBefore: string;
  payout: string;    // 80%
  remained: string;  // 20% 留底
  createdAt: string;
}

export interface JackpotHistoryRes {
  items: JackpotHistoryItem[];
  total: number;
  page: number;
  limit: number;
}
