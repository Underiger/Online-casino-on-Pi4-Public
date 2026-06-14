import { z } from 'zod';

// ── Requests ─────────────────────────────────────────────────────────────────

export const RedeemGiftCodeReqSchema = z.object({
  code: z.string().min(1).max(32),
});
export type RedeemGiftCodeReq = z.infer<typeof RedeemGiftCodeReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface RedeemGiftCodeRes {
  coin: string;             // BigInt → string
  charmId: string | null;   // UserCharm.id（若兌換碼附帶護符）
  newBalance: string;
}
