/**
 * 射龍門模組 API 端點（docs/04_API_SPEC.md 射龍門章節）。
 * POST /api/dragon-gate/bet 需附 HMAC 標頭；/open 只需登入。
 */
import http from '../http';
import { signRequest, toHmacHeaders } from '../sign';
import type { DragonGateBetReq, DragonGateBetRes, DragonGateOpenRes } from '@casino/shared';

export async function apiOpenDoors(): Promise<DragonGateOpenRes> {
  const res = await http.post<DragonGateOpenRes>('/dragon-gate/open');
  return res.data;
}

export async function apiBetDragonGate(req: DragonGateBetReq): Promise<DragonGateBetRes> {
  const { useAuthStore } = await import('../../stores/auth');
  const auth = useAuthStore();

  if (auth.user === null || auth.hmacKey === null) {
    throw new Error('未登入');
  }

  const signed = await signRequest({
    hmacKey: auth.hmacKey,
    userId: auth.user.id,
    gameType: 'DRAGON_GATE',
    betAmount: req.betAmount,
    seq: auth.nextSeq(),
  });

  const hmacHeaders: Record<string, string> = { ...toHmacHeaders(signed) };
  const res = await http.post<DragonGateBetRes>('/dragon-gate/bet', req, { headers: hmacHeaders });
  return res.data;
}
