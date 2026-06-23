/**
 * Blackjack 模組 API 端點（docs/04_API_SPEC.md Blackjack 章節）。
 * POST /api/blackjack/deal 需附 HMAC 標頭；hit/stand/double 只需登入。
 */
import http from '../http';
import { signRequest, toHmacHeaders } from '../sign';
import type { BlackjackActionRes, BlackjackDealReq, BlackjackRoundReq } from '@casino/shared';

export async function apiDealBlackjack(req: BlackjackDealReq): Promise<BlackjackActionRes> {
  const { useAuthStore } = await import('../../stores/auth');
  const auth = useAuthStore();

  if (auth.user === null || auth.hmacKey === null) {
    throw new Error('未登入');
  }

  const signed = await signRequest({
    hmacKey: auth.hmacKey,
    userId: auth.user.id,
    gameType: 'BLACKJACK',
    betAmount: req.betAmount,
    seq: auth.nextSeq(),
  });

  const hmacHeaders: Record<string, string> = { ...toHmacHeaders(signed) };
  const res = await http.post<BlackjackActionRes>('/blackjack/deal', req, { headers: hmacHeaders });
  return res.data;
}

export async function apiHitBlackjack(req: BlackjackRoundReq): Promise<BlackjackActionRes> {
  const res = await http.post<BlackjackActionRes>('/blackjack/hit', req);
  return res.data;
}

export async function apiStandBlackjack(req: BlackjackRoundReq): Promise<BlackjackActionRes> {
  const res = await http.post<BlackjackActionRes>('/blackjack/stand', req);
  return res.data;
}

export async function apiDoubleBlackjack(req: BlackjackRoundReq): Promise<BlackjackActionRes> {
  const res = await http.post<BlackjackActionRes>('/blackjack/double', req);
  return res.data;
}
