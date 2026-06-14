/**
 * Slot store（04_FOLDER_STRUCTURE §2 stores/slot.ts）：
 * 管理老虎機遊戲狀態——注額、旋轉結果、保底計數、Jackpot 即時金額。
 */
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { PITY_DEFAULT_THRESHOLD, SLOT_BET_AMOUNTS } from '@casino/shared';
import type { SlotBetAmount, SpinRes } from '@casino/shared';
import axios from 'axios';

export const useSlotStore = defineStore('slot', () => {
  // ── state ──
  const betAmount = ref<SlotBetAmount>(SLOT_BET_AMOUNTS[0]);
  const isSpinning = ref(false);
  const lastResult = ref<SpinRes | null>(null);
  const pityCount = ref(0);
  const error = ref<string | null>(null);
  /** 由 Socket JACKPOT_TICK 事件寫入，供 SlotView 顯示 */
  const jackpotPool = ref<string | null>(null);

  // ── getters ──
  const currentPityThreshold = computed(() => PITY_DEFAULT_THRESHOLD);

  // ── actions ──
  function setBetAmount(amount: SlotBetAmount): void {
    betAmount.value = amount;
  }

  function setJackpotPool(pool: string): void {
    jackpotPool.value = pool;
  }

  /**
   * 發起旋轉請求。
   * - 成功：更新 lastResult、pityCount、walletStore 餘額，回傳 SpinRes
   * - 失敗：設定 error 訊息，回傳 null
   */
  async function spin(amount: SlotBetAmount): Promise<SpinRes | null> {
    if (isSpinning.value) return null;

    isSpinning.value = true;
    error.value = null;

    try {
      const { apiSpin } = await import('../api/endpoints/slot');
      const result = await apiSpin({ betAmount: amount });

      lastResult.value = result;
      pityCount.value = result.pityCounter;

      // 以 Server 回傳值覆蓋本地餘額（server-authoritative balance）
      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(result.newBalance);

      return result;
    } catch (e) {
      if (axios.isAxiosError(e) && e.response !== undefined) {
        const data = e.response.data as { error?: { code?: string; message?: string } };
        const code = data?.error?.code ?? '';
        if (e.response.status === 422 || code === 'INSUFFICIENT_BALANCE') {
          error.value = '餘額不足，請選擇較小的注額。';
        } else if (e.response.status === 429) {
          error.value = '操作太快，請稍候再試。';
        } else if (e.response.status === 400) {
          error.value = '請求無效，請重新整理後再試。';
        } else {
          error.value = data?.error?.message ?? '旋轉失敗，請稍後再試。';
        }
      } else {
        error.value = e instanceof Error ? e.message : '旋轉失敗，請稍後再試。';
      }
      return null;
    } finally {
      isSpinning.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    betAmount,
    isSpinning,
    lastResult,
    pityCount,
    error,
    jackpotPool,
    currentPityThreshold,
    setBetAmount,
    setJackpotPool,
    spin,
    clearError,
  };
});
