/**
 * Achievement & Profile API（M20；docs/04_API_SPEC.md §3.10）。
 */
import http from '../http';

export interface AchievementItem {
  achievementId: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: string;
  unlockedAt: string | null;
}

export interface AchievementsRes {
  items: AchievementItem[];
}

export interface ProfileStats {
  totalSpins: number;
  maxSingleWin: string;
  jackpotWins: number;
  charmsOwned: number;
  totalCharms: number;
}

export interface ProfileSnapshotEntry {
  kind: string;
  periodKey: string | null;
  rank: number;
  score: string;
}

export interface ProfileRes {
  userId: string;
  username: string;
  avatarId: number;
  balance: string;
  stats: ProfileStats;
  leaderboardHistory: ProfileSnapshotEntry[];
}

export async function apiGetAchievements(): Promise<AchievementsRes> {
  const res = await http.get<AchievementsRes>('/achievements');
  return res.data;
}

export async function apiGetProfile(): Promise<ProfileRes> {
  const res = await http.get<ProfileRes>('/user/profile');
  return res.data;
}
