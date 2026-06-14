/**
 * Wallet store（04_FOLDER_STRUCTURE §2 stores/wallet.ts）：
 * 管理玩家餘額狀態，供 CoinDisplay 元件訂閱。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { useAuthStore } from './auth';

export const useWalletStore = defineStore('wallet', () => {
  const balance = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchBalance(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const { apiGetBalance } = await import('../api/endpoints/wallet');
      const res = await apiGetBalance();
      balance.value = res.balance;
      // 同步至 auth store user.balance（CoinDisplay 等處可從兩處讀取）
      useAuthStore().setBalance(res.balance);
    } catch (e) {
      error.value = e instanceof Error ? e.message : '取得餘額失敗';
    } finally {
      loading.value = false;
    }
  }

  /** 由遊戲結算後 server response 直接更新（無需再次 fetch） */
  function setBalance(newBalance: string): void {
    balance.value = newBalance;
    useAuthStore().setBalance(newBalance);
  }

  return { balance, loading, error, fetchBalance, setBalance };
});
