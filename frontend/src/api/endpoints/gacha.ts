/**
 * 扭蛋機 API 端點。
 * 扭蛋為商店型操作，不需 HMAC 簽章，只需 JWT（Bearer）。
 */
import http from '../http';
import type { GachaCatalogRes, GachaPullReq, GachaPullRes } from '@casino/shared';

export async function apiGetGachaCatalog(): Promise<GachaCatalogRes> {
  const res = await http.get<GachaCatalogRes>('/gacha/catalog');
  return res.data;
}

export async function apiGachaPull(req: GachaPullReq): Promise<GachaPullRes> {
  const res = await http.post<GachaPullRes>('/gacha/pull', req);
  return res.data;
}
