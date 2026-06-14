/**
 * Leaderboard API 端點（docs/04_API_SPEC.md §3.9）。
 */
import http from '../http';
import type { LeaderboardRes } from '@casino/shared';

export async function apiGetLeaderboard(kind: 'daily' | 'weekly' | 'total'): Promise<LeaderboardRes> {
  const res = await http.get<LeaderboardRes>(`/leaderboard/${kind}`);
  return res.data;
}
