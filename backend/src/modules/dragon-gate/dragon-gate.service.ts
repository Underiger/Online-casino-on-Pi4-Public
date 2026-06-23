/**
 * 射龍門服務（規則與賠率推導見 config/constants.ts 射龍門章節）。
 *
 * 流程：
 *   1. open()：開兩張門牌（gap<=0 自動重開門，見 payout.ts drawValidDoors）、依目前
 *      DRAGON_GATE_ODDS_MODE 算倍率，存進 Redis `dragon-gate:round:{userId}`（短 TTL，
 *      不動錢）。
 *   2. bet()：GETDEL 原子讀出並清掉 Redis 狀態（整回合唯一一次動錢的單步操作，
 *      不需要 round-lock——見 security/round-lock.ts 檔頭說明），核對 roundId →
 *      單一 PG 交易：BetRecord → wallet.debit(注額) → 由已存的 remainingDeck 取第三張牌
 *      → 介於兩門：wallet.credit；踩柱：再嘗試 debit 一次（餘額不足僅記日誌降級為
 *      單注損失）；門外：不再動錢。
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  DRAGON_GATE_MAX_BET,
  DRAGON_GATE_MIN_BET,
  DRAGON_GATE_ODDS_MODE,
} from '../../config/constants.js';
import { rngBytes, rngToken } from '../../security/csprng.js';
import { InsufficientBalanceError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type { RngFn } from '../../shared/cards.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { drawValidDoors, getMultiplier, resolveOutcome, settle } from './payout.js';
import type { BetOutcome, DragonGateRoundState, OpenDoorsResult } from './dragon-gate.types.js';

export const DRAGON_GATE_ROUND_KEY_PREFIX = 'dragon-gate:round:';
/** 開門後等待下注的時間窗：賠率已攤開讓玩家看,不需要留太久 */
export const DRAGON_GATE_ROUND_TTL_SECONDS = 120;

export function roundKey(userId: string): string {
  return `${DRAGON_GATE_ROUND_KEY_PREFIX}${userId}`;
}

function newRoundId(): string {
  return `DG${Date.now().toString(36)}-${rngToken(6)}`;
}

/** Redis JSON → DragonGateRoundState；結構不符回 null（等同回合不存在，安全降級） */
function parseRoundState(raw: string): DragonGateRoundState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const s = data as Partial<DragonGateRoundState>;
  if (
    typeof s.roundId !== 'string' ||
    !Array.isArray(s.doors) ||
    s.doors.length !== 2 ||
    typeof s.gap !== 'number' ||
    typeof s.multiplier !== 'number' ||
    !Array.isArray(s.remainingDeck) ||
    typeof s.serverSeedHash !== 'string'
  ) {
    return null;
  }
  return s as DragonGateRoundState;
}

export interface DragonGateLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface DragonGateServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  log?: DragonGateLog;
  /** 測試注入：決定性 rng 驅動洗牌（預設 csprng rngInt） */
  rng?: RngFn;
}

export function createDragonGateService(deps: DragonGateServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: DragonGateLog = deps.log ?? { warn: () => {} };

  return {
    /** POST /api/dragon-gate/open：開門牌，不動錢 */
    async open(userId: string): Promise<OpenDoorsResult> {
      const { doors, gap, remainingDeck } = drawValidDoors(deps.rng);
      const multiplier = getMultiplier(gap, DRAGON_GATE_ODDS_MODE);
      const roundId = newRoundId();
      const serverSeedHash = createHash('sha256').update(rngBytes(32)).digest('hex');

      const state: DragonGateRoundState = {
        roundId,
        doors,
        gap,
        oddsMode: DRAGON_GATE_ODDS_MODE,
        multiplier,
        remainingDeck,
        serverSeedHash,
      };
      await redis.set(roundKey(userId), JSON.stringify(state), 'EX', DRAGON_GATE_ROUND_TTL_SECONDS);

      return { roundId, doors, gap, oddsMode: DRAGON_GATE_ODDS_MODE, multiplier };
    },

    /** POST /api/dragon-gate/bet：HMAC 簽章；GETDEL 原子取用本局狀態並結算 */
    async bet(userId: string, roundId: string, betAmount: number): Promise<BetOutcome> {
      if (
        !Number.isSafeInteger(betAmount) ||
        betAmount < DRAGON_GATE_MIN_BET ||
        betAmount > DRAGON_GATE_MAX_BET
      ) {
        throw new ValidationError(`注額須為 ${DRAGON_GATE_MIN_BET}~${DRAGON_GATE_MAX_BET} 之間的整數`);
      }

      const raw = await redis.getdel(roundKey(userId));
      const state = raw === null ? null : parseRoundState(raw);
      if (state === null || state.roundId !== roundId) {
        throw new NotFoundError('回合不存在或已結算，請重新開門');
      }

      const thirdCard = state.remainingDeck[0];
      if (thirdCard === undefined) {
        throw new NotFoundError('回合狀態損毀，請重新開門');
      }
      const outcome = resolveOutcome(state.doors, thirdCard);
      const result = settle(betAmount, outcome, state.multiplier);
      const serverSeedHash = state.serverSeedHash;

      const txOut = await prisma.$transaction(async (tx) => {
        const betRecord = await tx.betRecord.create({
          data: {
            userId,
            gameType: 'DRAGON_GATE',
            amount: BigInt(betAmount),
            payout: BigInt(result.payout),
            roundId,
            serverSeedHash,
            detail: {
              doors: state.doors,
              gap: state.gap,
              oddsMode: state.oddsMode,
              multiplier: state.multiplier,
              thirdCard,
              outcome,
              extraLossApplied: false,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        const debit = await wallet.debit(userId, BigInt(betAmount), 'BET', {
          tx,
          refId: betRecord.id,
        });
        let newBalance = debit.balance;

        if (outcome === 'WIN') {
          const credit = await wallet.credit(userId, BigInt(result.payout), 'PAYOUT', {
            tx,
            refId: betRecord.id,
          });
          newBalance = credit.balance;
        }

        let extraLossApplied = false;
        if (outcome === 'DOOR_HIT' && result.extraLoss > 0) {
          try {
            const extraDebit = await wallet.debit(userId, BigInt(result.extraLoss), 'BET', {
              tx,
              refId: betRecord.id,
            });
            newBalance = extraDebit.balance;
            extraLossApplied = true;
          } catch (err) {
            if (!(err instanceof InsufficientBalanceError)) throw err;
            // 罕見併發競態（下注後餘額被別處用掉）：降級為只輸單注，不卡住結算
            log.warn(
              { userId, betRecordId: betRecord.id },
              'dragon-gate: 踩柱加倍扣款餘額不足，降級為單注損失',
            );
          }
        }

        if (extraLossApplied) {
          const detail = betRecord.detail as Record<string, unknown>;
          await tx.betRecord.update({
            where: { id: betRecord.id },
            data: { detail: { ...detail, extraLossApplied: true } },
          });
        }

        return { betRecordId: betRecord.id, newBalance, extraLossApplied };
      });

      return {
        betRecordId: txOut.betRecordId,
        outcome,
        thirdCard,
        betAmount,
        payout: result.payout,
        extraLossApplied: txOut.extraLossApplied,
        newBalance: txOut.newBalance,
        doors: state.doors,
        gap: state.gap,
        multiplier: state.multiplier,
      };
    },
  };
}

export type DragonGateService = ReturnType<typeof createDragonGateService>;
