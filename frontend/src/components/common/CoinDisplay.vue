<script setup lang="ts">
/**
 * CoinDisplay（04_FOLDER_STRUCTURE §2 components/common/CoinDisplay.vue）：
 * 顯示玩家目前餘額，訂閱 wallet store，
 * 支援「閃爍更新」視覺反饋（餘額變動時短暫高亮）。
 */
import { ref, watch } from 'vue';
import { useWalletStore } from '../../stores/wallet';

const wallet = useWalletStore();

/** 上一次的餘額，用於判斷是否增/減 */
const prevBalance = ref<string | null>(null);
const flashClass = ref<'flash-up' | 'flash-down' | null>(null);

watch(
  () => wallet.balance,
  (next, prev) => {
    if (prev === null || next === null) {
      prevBalance.value = next;
      return;
    }
    const diff = BigInt(next) - BigInt(prev);
    flashClass.value = diff > 0n ? 'flash-up' : diff < 0n ? 'flash-down' : null;
    if (flashClass.value !== null) {
      setTimeout(() => { flashClass.value = null; }, 600);
    }
    prevBalance.value = next;
  },
);

function formatCoin(val: string | null): string {
  if (val === null) return '—';
  try {
    return Number(BigInt(val)).toLocaleString();
  } catch {
    return val;
  }
}
</script>

<template>
  <span class="coin-display" :class="flashClass">
    <span class="coin-icon">🪙</span>
    <span class="coin-value">{{ formatCoin(wallet.balance) }}</span>
  </span>
</template>

<style scoped>
.coin-display {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  font-size: 1.1rem;
  transition: color 0.3s;
}

.flash-up {
  color: #2ecc71;
}

.flash-down {
  color: #e74c3c;
}
</style>
