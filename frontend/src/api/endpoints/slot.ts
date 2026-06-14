/**
 * 老虎機模組 API 端點（docs/04_API_SPEC.md §3.4）。
 * POST /api/slot/spin 需附 HMAC 標頭。
 */
import http from '../http';
import { signRequest, toHmacHeaders } from '../sign';
import type { SpinReq, SpinRes, SlotPaytableRes } from '@casino/shared';

export async function apiSpin(req: SpinReq): Promise<SpinRes> {
  const { useAuthStore } = await import('../../stores/auth');
  const auth = useAuthStore();

  if (auth.user === null || auth.hmacKey === null) {
    throw new Error('未登入');
  }

  const signed = await signRequest({
    hmacKey: auth.hmacKey,
    userId: auth.user.id,
    gameType: 'SLOT',
    betAmount: req.betAmount,
    seq: auth.nextSeq(),
  });

  const hmacHeaders: Record<string, string> = { ...toHmacHeaders(signed) };
  const res = await http.post<SpinRes>('/slot/spin', req, { headers: hmacHeaders });
  return res.data as SpinRes;
}

export async function apiGetPaytable(): Promise<SlotPaytableRes> {
  const res = await http.get<SlotPaytableRes>('/slot/paytable');
  return res.data;
}
