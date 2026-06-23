import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { GachaCatalogRes, GachaPullRes } from '@casino/shared';
import { apiGachaPull, apiGetGachaCatalog } from '../api/endpoints/gacha';
import { useWalletStore } from './wallet';

/** 後端錯誤碼 → 玩家文案 */
function messageFor(err: unknown): string {
  const code = (err as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code;
  if (code === 'INSUFFICIENT_BALANCE') return '餘額不足，無法抽取';
  if (code === 'RATE_LIMIT_EXCEEDED') return '操作過於頻繁，請稍後再試';
  return '抽取失敗，請稍後再試';
}

export const useGachaStore = defineStore('gacha', () => {
  const catalog = ref<GachaCatalogRes | null>(null);
  const loading = ref(false);
  const pulling = ref(false);
  const error = ref<string | null>(null);

  async function fetchCatalog(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      catalog.value = await apiGetGachaCatalog();
    } catch {
      error.value = '無法載入扭蛋資料';
    } finally {
      loading.value = false;
    }
  }

  /** 抽取；成功回傳結果並同步餘額 + 重新整理收集狀態，失敗回傳 null 並設定 error */
  async function pull(count: 1 | 10): Promise<GachaPullRes | null> {
    if (pulling.value) return null;
    pulling.value = true;
    error.value = null;
    try {
      const res = await apiGachaPull({ count });
      useWalletStore().setBalance(res.newBalance);
      // 重新整理 owned 狀態（不阻塞回傳——抽取結果已在手）
      void fetchCatalog();
      return res;
    } catch (e) {
      error.value = messageFor(e);
      return null;
    } finally {
      pulling.value = false;
    }
  }

  return { catalog, loading, pulling, error, fetchCatalog, pull };
});
