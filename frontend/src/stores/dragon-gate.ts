/**
 * Dragon Gate（射龍門）store：管理開門/下注狀態。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { DRAGON_GATE_MIN_BET } from '@casino/shared';
import type { DragonGateBetRes, DragonGateOpenRes } from '@casino/shared';
import axios from 'axios';

export const useDragonGateStore = defineStore('dragon-gate', () => {
  // ── state ──
  const betAmount = ref<number>(DRAGON_GATE_MIN_BET);
  const isOpening = ref(false);
  const isBetting = ref(false);
  const currentRound = ref<DragonGateOpenRes | null>(null);
  const lastResult = ref<DragonGateBetRes | null>(null);
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
      if (e.response.status === 404) return '回合已結算或不存在，請重新開門。';
      if (e.response.status === 400) return '請求無效，請重新整理後再試。';
      return data?.error?.message ?? fallback;
    }
    return e instanceof Error ? e.message : fallback;
  }

  /** 開門：不動錢，回傳門牌與本局倍率 */
  async function openDoors(): Promise<DragonGateOpenRes | null> {
    if (isOpening.value) return null;
    isOpening.value = true;
    error.value = null;
    lastResult.value = null;

    try {
      const { apiOpenDoors } = await import('../api/endpoints/dragon-gate');
      const result = await apiOpenDoors();
      currentRound.value = result;
      return result;
    } catch (e) {
      error.value = mapError(e, '開門失敗，請稍後再試。');
      return null;
    } finally {
      isOpening.value = false;
    }
  }

  /** 對目前已開的門下注 */
  async function bet(amount: number): Promise<DragonGateBetRes | null> {
    if (isBetting.value || currentRound.value === null) return null;
    isBetting.value = true;
    error.value = null;

    try {
      const { apiBetDragonGate } = await import('../api/endpoints/dragon-gate');
      const result = await apiBetDragonGate({ roundId: currentRound.value.roundId, betAmount: amount });
      lastResult.value = result;
      currentRound.value = null; // 回合已結算（後端 GETDEL 已消費）

      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(result.newBalance);

      return result;
    } catch (e) {
      error.value = mapError(e, '下注失敗，請稍後再試。');
      currentRound.value = null; // 失敗也視為回合已失效，要求重新開門最安全
      return null;
    } finally {
      isBetting.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    betAmount,
    isOpening,
    isBetting,
    currentRound,
    lastResult,
    error,
    setBetAmount,
    openDoors,
    bet,
    clearError,
  };
});
