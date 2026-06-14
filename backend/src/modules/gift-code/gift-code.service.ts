/**
 * Gift Code 兌換服務（M22）。
 *
 * 職責：玩家兌換禮物碼（建立由 M21 admin.service.createGiftCode 負責）。
 *
 * 競態條件防護（雙重保險）：
 *   1. DB 層：GiftCodeRedemption @@unique([giftCodeId, userId])
 *      → 同人重複兌換同一碼觸發 Prisma P2002，攔截後轉 GIFT_CODE_ALREADY_REDEEMED。
 *   2. 樂觀條件更新：UPDATE gift_codes SET used_count = used_count + 1
 *      WHERE id=:id AND used_count < max_uses AND expires_at > now()
 *      → 受影響行數 = 0 表示碼已用完或剛過期，回 GIFT_CODE_ALREADY_USED。
 *
 * 原子性：條件更新 + GiftCodeRedemption 插入 + wallet.credit + 護符授予全在同一
 * $transaction 內，任一步驟失敗皆完整回滾（餘額鐵律：credit 走 wallet 模組）。
 */
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../shared/errors.js';
import type { WalletService } from '../wallet/wallet.service.js';
import type { RedeemGiftCodeRes } from './gift-code.types.js';

// ─── 型別 ─────────────────────────────────────────────────────────────────────

export interface GiftCodeServiceDeps {
  prisma: PrismaClient;
  wallet: Pick<WalletService, 'credit'>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createGiftCodeService(deps: GiftCodeServiceDeps) {
  const { prisma, wallet } = deps;

  /**
   * 兌換禮物碼。
   * 大小寫不敏感：input code 標準化為大寫後查 DB。
   */
  async function redeemGiftCode(userId: string, rawCode: string): Promise<RedeemGiftCodeRes> {
    const code = rawCode.toUpperCase();

    const gc = await prisma.giftCode.findUnique({
      where: { code },
      select: {
        id: true,
        amount: true,
        charmId: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
      },
    });

    if (gc === null) {
      throw new AppError('禮物碼不存在', 404, 'GIFT_CODE_NOT_FOUND');
    }
    // 快速前置檢查（非原子；真實防護在交易內的條件更新）
    if (gc.expiresAt <= new Date()) {
      throw new AppError('禮物碼已過期', 409, 'GIFT_CODE_EXPIRED');
    }
    if (gc.usedCount >= gc.maxUses) {
      throw new AppError('禮物碼已用完', 409, 'GIFT_CODE_ALREADY_USED');
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1. 原子條件更新（防 usedCount 超限競態）
        const { count } = await tx.giftCode.updateMany({
          where: {
            id: gc.id,
            usedCount: { lt: gc.maxUses },
            expiresAt: { gt: new Date() },
          },
          data: { usedCount: { increment: 1 } },
        });
        if (count === 0) {
          throw new AppError('禮物碼已用完或已過期', 409, 'GIFT_CODE_ALREADY_USED');
        }

        // 2. 建立兌換紀錄（@@unique([giftCodeId, userId]) 攔截重複兌換 → P2002）
        const redemption = await tx.giftCodeRedemption.create({
          data: { giftCodeId: gc.id, userId },
          select: { id: true },
        });

        // 3. 入帳（餘額鐵律：credit 走 wallet，與 redemption 同 tx）
        const w = await wallet.credit(userId, gc.amount, 'GIFT_CODE', {
          tx,
          refId: redemption.id,
          memo: `禮物碼兌換`,
        });

        // 4. 授予護符（若有附贈）——upsert 防重複持有
        let charmName: string | null = null;
        if (gc.charmId !== null) {
          await tx.userCharm.upsert({
            where: { userId_charmId: { userId, charmId: gc.charmId } },
            create: { userId, charmId: gc.charmId },
            update: {},
          });
          const charm = await tx.charm.findUnique({
            where: { id: gc.charmId },
            select: { name: true },
          });
          charmName = charm?.name ?? null;
        }

        return { balance: w.balance, charmName };
      });

      return {
        success: true,
        amount: gc.amount.toString(),
        charmId: gc.charmId,
        charmName: result.charmName,
        newBalance: result.balance.toString(),
      };
    } catch (err) {
      // P2002 = GiftCodeRedemption unique 約束違反（同人重複兌換同一碼）
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new AppError('您已兌換過此禮物碼', 409, 'GIFT_CODE_ALREADY_REDEEMED');
      }
      throw err;
    }
  }

  return { redeemGiftCode };
}

export type GiftCodeService = ReturnType<typeof createGiftCodeService>;
