/**
 * Roulette REST API 端點（04_FOLDER_STRUCTURE §2 api/endpoints/roulette.ts）。
 * 僅 GET /roulette/state 供初始同步；下注/取消走 Socket.IO。
 */
import http from '../http';
import type { RouletteRoundStateRes } from '@casino/shared';

/** 取得當前回合狀態（中途加入時呼叫，同步 phase/endsAt/roundId） */
export async function apiGetRouletteState(): Promise<RouletteRoundStateRes> {
  const res = await http.get<RouletteRoundStateRes>('/roulette/state');
  return res.data;
}
