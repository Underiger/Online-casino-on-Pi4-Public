import { LeaderboardKind } from '../enums';

// ── Response types ────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarId: number;
  score: string; // BigInt → string（淨贏分或總資產，依榜別）
}

export interface LeaderboardRes {
  kind: LeaderboardKind;
  /** DAILY/WEEKLY 的日期或週編號；TOTAL 為 null */
  periodKey: string | null;
  entries: LeaderboardEntry[];
  /** 物化視圖最後刷新時間 */
  refreshedAt: string;
}

/** 個人歷史名次快照 */
export interface LeaderboardSnapshotItem {
  kind: LeaderboardKind;
  periodKey: string | null;
  rank: number;
  score: string;
  createdAt: string;
}

export interface UserLeaderboardHistoryRes {
  items: LeaderboardSnapshotItem[];
}
