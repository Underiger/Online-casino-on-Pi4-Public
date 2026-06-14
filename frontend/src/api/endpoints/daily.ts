/**
 * Daily System API 端點（docs/04_API_SPEC.md §3.7）。
 */
import http from '../http';
import type { DailyLoginRes, DailyTasksRes, ClaimTaskRes } from '@casino/shared';

export async function apiClaimDailyLogin(): Promise<DailyLoginRes> {
  const res = await http.post<DailyLoginRes>('/daily/login');
  return res.data;
}

export async function apiGetDailyTasks(): Promise<DailyTasksRes> {
  const res = await http.get<DailyTasksRes>('/daily/tasks');
  return res.data;
}

export async function apiClaimTask(progressId: string): Promise<ClaimTaskRes> {
  const res = await http.post<ClaimTaskRes>(`/daily/tasks/${progressId}/claim`);
  return res.data;
}
