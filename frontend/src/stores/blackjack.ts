/**
 * Blackjack store：管理發牌/要牌/停牌/加倍的回合狀態。
 *
 * round 直接存後端回應（BlackjackActionRes），settled 為 discriminant：
 * settled=false 時底牌隱藏（只有 dealerUpCard）；settled=true 時是終局結果。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { BLACKJACK_MIN_BET } from '@casino/shared';
import type { BlackjackActionRes } from '@casino/shared';
import axios from 'axios';

export const useBlackjackStore = defineStore('blackjack', () => {
  // ── state ──
  const betAmount = ref<number>(BLACKJACK_MIN_BET);
  const isDealing = ref(false);
  const isActing = ref(false);
  const round = ref<BlackjackActionRes | null>(null);
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

  async function applyResult(result: BlackjackActionRes): Promise<void> {
    round.value = result;
    if (result.settled) {
      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(result.newBalance);
    }
  }

  /** 下注發牌（天生 BJ 會直接回終局結果） */
  async function deal(amount: number): Promise<boolean> {
    if (isDealing.value || round.value !== null) return false;
    isDealing.value = true;
    error.value = null;

    try {
      const { apiDealBlackjack } = await import('../api/endpoints/blackjack');
      const result = await apiDealBlackjack({ betAmount: amount });
      await applyResult(result);
      if (!result.settled) {
        // 還在 PLAYER_TURN：deal 已扣注額但回應沒附 newBalance，補抓一次餘額
        const { useWalletStore } = await import('./wallet');
        void useWalletStore().fetchBalance();
      }
      return true;
    } catch (e) {
      error.value = mapError(e, '發牌失敗，請稍後再試。');
      return false;
    } finally {
      isDealing.value = false;
    }
  }

  async function runAction(
    apiCall: (req: { roundId: string }) => Promise<BlackjackActionRes>,
    fallbackMsg: string,
  ): Promise<boolean> {
    if (isActing.value || round.value === null || round.value.settled) return false;
    isActing.value = true;
    error.value = null;

    try {
      const result = await apiCall({ roundId: round.value.roundId });
      await applyResult(result);
      return true;
    } catch (e) {
      error.value = mapError(e, fallbackMsg);
      round.value = null; // 失敗也視為回合已失效，要求重新下注最安全
      return false;
    } finally {
      isActing.value = false;
    }
  }

  async function hit(): Promise<boolean> {
    const { apiHitBlackjack } = await import('../api/endpoints/blackjack');
    return runAction(apiHitBlackjack, '要牌失敗，請稍後再試。');
  }

  async function stand(): Promise<boolean> {
    const { apiStandBlackjack } = await import('../api/endpoints/blackjack');
    return runAction(apiStandBlackjack, '停牌失敗，請稍後再試。');
  }

  async function double(): Promise<boolean> {
    const { apiDoubleBlackjack } = await import('../api/endpoints/blackjack');
    return runAction(apiDoubleBlackjack, '加倍失敗，請稍後再試。');
  }

  function startNewRound(): void {
    round.value = null;
    error.value = null;
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    betAmount,
    isDealing,
    isActing,
    round,
    error,
    setBetAmount,
    deal,
    hit,
    stand,
    double,
    startNewRound,
    clearError,
  };
});
