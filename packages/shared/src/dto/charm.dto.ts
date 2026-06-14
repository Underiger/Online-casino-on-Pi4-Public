import { z } from 'zod';
import { CharmRarity, CharmType } from '../enums';
import { CHARM_MAX_SLOTS } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

export const EquipCharmReqSchema = z.object({
  userCharmId: z.string().min(1),
  slot: z.number().int().min(1).max(CHARM_MAX_SLOTS),
});
export type EquipCharmReq = z.infer<typeof EquipCharmReqSchema>;

export const UnequipCharmReqSchema = z.object({
  slot: z.number().int().min(1).max(CHARM_MAX_SLOTS),
});
export type UnequipCharmReq = z.infer<typeof UnequipCharmReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface CharmDef {
  id: string;
  code: string;
  name: string;
  description: string;
  type: CharmType;
  rarity: CharmRarity;
  effect: unknown; // JSON，後端依 CharmType 解析
  enabled: boolean;
}

export interface UserCharmItem {
  id: string;         // UserCharm.id
  charmId: string;
  equipped: boolean;
  slot: number | null;
  obtainedAt: string;
  charm: CharmDef;
}

export interface CharmInventoryRes {
  items: UserCharmItem[];
}

/** 裝備/卸下後返回最新 Loadout 狀態 */
export interface LoadoutRes {
  equippedCharms: Array<{
    slot: number;
    userCharmId: string;
    charmId: string;
    name: string;
    type: CharmType;
    rarity: CharmRarity;
  }>;
  loadoutHash: string;
}
