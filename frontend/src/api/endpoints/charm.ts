/**
 * 護符模組 API 端點（docs/04_API_SPEC.md §3.5）。
 * charm 操作不需 HMAC 簽章，只需 JWT（Bearer）。
 */
import http from '../http';
import type { CharmInventoryRes, EquipCharmReq, UnequipCharmReq, LoadoutRes } from '@casino/shared';

export async function apiGetCharmInventory(): Promise<CharmInventoryRes> {
  const res = await http.get<CharmInventoryRes>('/charm/inventory');
  return res.data;
}

export async function apiEquipCharm(req: EquipCharmReq): Promise<LoadoutRes> {
  const res = await http.post<LoadoutRes>('/charm/equip', req);
  return res.data as LoadoutRes;
}

export async function apiUnequipCharm(req: UnequipCharmReq): Promise<LoadoutRes> {
  const res = await http.post<LoadoutRes>('/charm/unequip', req);
  return res.data as LoadoutRes;
}
