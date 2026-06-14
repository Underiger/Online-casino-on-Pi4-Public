/**
 * Gift Code 兌換 DTO（M22；01_GDD §6.5）。
 *
 * 建立禮物碼已在 M21 admin.service 實作（POST /api/admin/gift-codes 高危）。
 * 本模組聚焦玩家端兌換：POST /api/gift-codes/redeem（一般認證使用者）。
 *
 * 錯誤碼遵循 M05 規格：
 *   GIFT_CODE_NOT_FOUND    - 碼不存在
 *   GIFT_CODE_EXPIRED      - 已過期
 *   GIFT_CODE_ALREADY_USED - 已用完（usedCount >= maxUses）
 *   GIFT_CODE_ALREADY_REDEEMED - 同一使用者重複兌換同一碼（DB unique 約束）
 */
import { z } from 'zod';

export const RedeemGiftCodeReqSchema = z.object({
  /** 禮物碼；大小寫不敏感（服務層標準化為大寫） */
  code: z.string().min(1).max(32).trim(),
});
export type RedeemGiftCodeReq = z.infer<typeof RedeemGiftCodeReqSchema>;

export interface RedeemGiftCodeRes {
  success: true;
  /** 入帳金額（Coin，BigInt → string） */
  amount: string;
  /** 附贈護符 ID（無護符時為 null） */
  charmId: string | null;
  /** 附贈護符顯示名稱（無護符時為 null） */
  charmName: string | null;
  /** 兌換後餘額 */
  newBalance: string;
}
