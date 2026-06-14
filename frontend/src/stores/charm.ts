import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { UserCharmItem } from '@casino/shared';
import { apiGetCharmInventory, apiEquipCharm, apiUnequipCharm } from '../api/endpoints/charm';

export const useCharmStore = defineStore('charm', () => {
  const inventory = ref<UserCharmItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // 依槽位 1–3 取已裝備護符
  const equippedBySlot = computed((): Map<number, UserCharmItem> => {
    const map = new Map<number, UserCharmItem>();
    for (const item of inventory.value) {
      if (item.equipped && item.slot !== null) {
        map.set(item.slot, item);
      }
    }
    return map;
  });

  // 未裝備（可裝備）護符，依 obtainedAt 排序
  const available = computed((): UserCharmItem[] =>
    inventory.value
      .filter((i) => !i.equipped && i.charm.enabled)
      .sort((a, b) => a.obtainedAt.localeCompare(b.obtainedAt)),
  );

  async function fetchInventory(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await apiGetCharmInventory();
      inventory.value = res.items;
    } catch {
      error.value = '無法載入護符庫存';
    } finally {
      loading.value = false;
    }
  }

  async function equipCharm(userCharmId: string, slot: number): Promise<void> {
    error.value = null;
    try {
      await apiEquipCharm({ userCharmId, slot });
      // 重新拉取以同步最新 equipped 狀態
      await fetchInventory();
    } catch {
      error.value = '裝備失敗，請稍後再試';
    }
  }

  async function unequipCharm(slot: number): Promise<void> {
    error.value = null;
    try {
      await apiUnequipCharm({ slot });
      await fetchInventory();
    } catch {
      error.value = '卸下失敗，請稍後再試';
    }
  }

  return { inventory, loading, error, equippedBySlot, available, fetchInventory, equipCharm, unequipCharm };
});
