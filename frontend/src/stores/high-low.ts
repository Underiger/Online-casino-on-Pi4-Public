/**
 * High-Low store：管理下注/猜測/收手續押的回合狀態。
 *
 * round.state 跟後端 high-low.service.ts 的 GUESSING/RESULT 對應：
 *   GUESSING：等待 guess()；RESULT：等待 continueRound() 或 cashOut()。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { HIGH_LOW_MIN_BET } from '@casino/shared';
import type { Card, HighLowGuessOutcome } from '@casino/shared';
import axios from 'axios';

export interface HighLowRoundView {
  roundId: string;
  state: 'GUESSING' | 'RESULT';
  baseCard: Card;
  pot: number;
  streak: number;
}

export interface HighLowOutcomeView {
  outcome: HighLowGuessOutcome | 'CASH_OUT';
  revealedCard?: Card;
  payout?: number;
}

export const useHighLowStore = defineStore('high-low', () => {
  // ── state ──
  const betAmount = ref<number>(HIGH_LOW_MIN_BET);
  const isDealing = ref(false);
  const isActing = ref(false);
  const round = ref<HighLowRoundView | null>(null);
  const lastOutcome = ref<HighLowOutcomeView | null>(null);
  const error = ref<string | null>(null);

  function setBetAmount(amount: number): void {
    betAmount.value = amount;
  }

  function mapError(e: unknown, fallback: string): string {
    if (axios.isAxiosError(e) && e.response !== undefined) {
      const data = e.response.data as { error?: { code?: string; message?: string } };
      const code = data?.error?.code ?? '';
      if (e.response.status === 422 || code === 'INSUFFICIENT_BALANCE') return '餘額不足，請選擇較小的注額。';
      if (e.response.status === 429) return '操作太快，請稍候再試。';
      if (e.response.status === 404) return '回合已結算或不存在，請重新下注。';
      if (e.response.status === 409) return '請稍候，上一個操作還在處理中。';
      if (e.response.status === 400) return '請求無效，請重新整理後再試。';
      return data?.error?.message ?? fallback;
    }
    return e instanceof Error ? e.message : fallback;
  }

  async function setBalance(newBalance: string): Promise<void> {
    const { useWalletStore } = await import('./wallet');
    useWalletStore().setBalance(newBalance);
  }

  /** 下注開局 */
  async function deal(amount: number): Promise<boolean> {
    if (isDealing.value || round.value !== null) return false;
    isDealing.value = true;
    error.value = null;
    lastOutcome.value = null;

    try {
      const { apiDealHighLow } = await import('../api/endpoints/high-low');
      const result = await apiDealHighLow({ betAmount: amount });
      round.value = { roundId: result.roundId, state: 'GUESSING', baseCard: result.baseCard, pot: result.pot, streak: 0 };
      // deal 一定會扣注額，但回應沒有附 newBalance（回合才剛開始，還沒結算），補抓一次餘額
      const { useWalletStore } = await import('./wallet');
      void useWalletStore().fetchBalance();
      return true;
    } catch (e) {
      error.value = mapError(e, '下注失敗，請稍後再試。');
      return false;
    } finally {
      isDealing.value = false;
    }
  }

  /** 猜高/低 */
  async function guess(guessHigh: boolean): Promise<boolean> {
    if (isActing.value || round.value === null || round.value.state !== 'GUESSING') return false;
    isActing.value = true;
    error.value = null;

    try {
      const { apiGuessHighLow } = await import('../api/endpoints/high-low');
      const result = await apiGuessHighLow({ roundId: round.value.roundId, guessHigh });
      lastOutcome.value = { outcome: result.outcome, revealedCard: result.revealedCard, payout: result.payout };

      if (result.outcome === 'PUSH') {
        round.value = { ...round.value, baseCard: result.revealedCard };
      } else if (result.outcome === 'WIN_CONTINUE') {
        round.value = { ...round.value, state: 'RESULT', pot: result.pot, streak: result.streak };
      } else {
        // WIN_MAX_STREAK / LOSE：回合終局
        round.value = null;
        if (result.newBalance !== null) await setBalance(result.newBalance);
      }
      return true;
    } catch (e) {
      error.value = mapError(e, '猜測失敗，請稍後再試。');
      round.value = null; // 失敗也視為回合已失效，要求重新下注最安全
      return false;
    } finally {
      isActing.value = false;
    }
  }

  /** 收手後選擇繼續挑戰 */
  async function continueRound(): Promise<boolean> {
    if (isActing.value || round.value === null || round.value.state !== 'RESULT') return false;
    isActing.value = true;
    error.value = null;
    lastOutcome.value = null;

    try {
      const { apiContinueHighLow } = await import('../api/endpoints/high-low');
      const result = await apiContinueHighLow({ roundId: round.value.roundId });
      round.value = { ...round.value, state: 'GUESSING', baseCard: result.baseCard, pot: result.pot, streak: result.streak };
      return true;
    } catch (e) {
      error.value = mapError(e, '繼續失敗，請稍後再試。');
      round.value = null;
      return false;
    } finally {
      isActing.value = false;
    }
  }

  /** 收手入袋 */
  async function cashOut(): Promise<boolean> {
    if (isActing.value || round.value === null || round.value.state !== 'RESULT') return false;
    isActing.value = true;
    error.value = null;

    try {
      const { apiCashOutHighLow } = await import('../api/endpoints/high-low');
      const result = await apiCashOutHighLow({ roundId: round.value.roundId });
      lastOutcome.value = { outcome: 'CASH_OUT', payout: result.payout };
      round.value = null;
      await setBalance(result.newBalance);
      return true;
    } catch (e) {
      error.value = mapError(e, '收手失敗，請稍後再試。');
      round.value = null;
      return false;
    } finally {
      isActing.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    betAmount,
    isDealing,
    isActing,
    round,
    lastOutcome,
    error,
    setBetAmount,
    deal,
    guess,
    continueRound,
    cashOut,
    clearError,
  };
});
