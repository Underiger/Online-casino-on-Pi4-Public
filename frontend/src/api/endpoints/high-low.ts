/**
 * High-Low 模組 API 端點（docs/04_API_SPEC.md High-Low 章節）。
 * POST /api/high-low/deal 需附 HMAC 標頭；guess/continue/cash-out 只需登入。
 */
import http from '../http';
import { signRequest, toHmacHeaders } from '../sign';
import type {
  HighLowCashOutRes,
  HighLowContinueRes,
  HighLowDealReq,
  HighLowDealRes,
  HighLowGuessReq,
  HighLowGuessRes,
  HighLowRoundReq,
} from '@casino/shared';

export async function apiDealHighLow(req: HighLowDealReq): Promise<HighLowDealRes> {
  const { useAuthStore } = await import('../../stores/auth');
  const auth = useAuthStore();

  if (auth.user === null || auth.hmacKey === null) {
    throw new Error('未登入');
  }

  const signed = await signRequest({
    hmacKey: auth.hmacKey,
    userId: auth.user.id,
    gameType: 'HIGH_LOW',
    betAmount: req.betAmount,
    seq: auth.nextSeq(),
  });

  const hmacHeaders: Record<string, string> = { ...toHmacHeaders(signed) };
  const res = await http.post<HighLowDealRes>('/high-low/deal', req, { headers: hmacHeaders });
  return res.data;
}

export async function apiGuessHighLow(req: HighLowGuessReq): Promise<HighLowGuessRes> {
  const res = await http.post<HighLowGuessRes>('/high-low/guess', req);
  return res.data;
}

export async function apiContinueHighLow(req: HighLowRoundReq): Promise<HighLowContinueRes> {
  const res = await http.post<HighLowContinueRes>('/high-low/continue', req);
  return res.data;
}

export async function apiCashOutHighLow(req: HighLowRoundReq): Promise<HighLowCashOutRes> {
  const res = await http.post<HighLowCashOutRes>('/high-low/cash-out', req);
  return res.data;
}
