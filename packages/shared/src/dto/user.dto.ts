import { z } from 'zod';
import type { CharmRarity, CharmType } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

export const UpdateAvatarReqSchema = z.object({
  avatarId: z.number().int().min(0).max(19),
});
export type UpdateAvatarReq = z.infer<typeof UpdateAvatarReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface UserProfileRes {
  id: string;
  username: string;
  balance: string; // BigInt → string
  avatarId: number;
  jackpotPoints: number;
  loginStreak: number;
  createdAt: string;
  stats: {
    totalSpins: number;
    totalRouletteRounds: number;
    maxSingleWin: string; // BigInt → string
    jackpotWins: number;
  };
}

export interface UpdateAvatarRes {
  avatarId: number;
}

export interface AchievementItem {
  achievementId: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: string; // BigInt → string
  unlockedAt: string;
}

export interface UserAchievementsRes {
  items: AchievementItem[];
}

/** 護符圖鑑項目（含玩家未持有的，用於圖鑑頁顯示收集度） */
export interface CharmGalleryItem {
  charmId: string;
  code: string;
  name: string;
  description: string;
  type: CharmType;
  rarity: CharmRarity;
  obtained: boolean;
  obtainedAt: string | null;
}

export interface UserCharmGalleryRes {
  items: CharmGalleryItem[];
  owned: number;
  total: number;
}
