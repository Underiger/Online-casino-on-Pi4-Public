<script setup lang="ts">
/**
 * PityIndicator（M12）：
 * 顯示保底計數進度──再 X 次未中獎將觸發保底加成（×1.5）。
 */
import { computed } from 'vue';
import { useSlotStore } from '../../stores/slot';

const slot = useSlotStore();

const threshold = computed(() => slot.currentPityThreshold);
const count = computed(() => slot.pityCount);
const remaining = computed(() => Math.max(0, threshold.value - count.value));
const progress = computed(() => (count.value / threshold.value) * 100);
const isReady = computed(() => count.value >= threshold.value);
</script>

<template>
  <div class="pity-indicator" :class="{ ready: isReady }">
    <div class="pity-header">
      <span class="pity-title">保底進度</span>
      <span class="pity-count">
        <template v-if="isReady">保底生效！</template>
        <template v-else>再 {{ remaining }} 次觸發</template>
      </span>
    </div>
    <div class="pity-bar-track" role="progressbar" :aria-valuenow="count" :aria-valuemax="threshold">
      <div
        class="pity-bar-fill"
        :style="{ width: `${Math.min(progress, 100)}%` }"
      />
    </div>
    <div class="pity-sub">
      {{ count }} / {{ threshold }} 次連敗　觸發後賠率 ×1.5
    </div>
  </div>
</template>

<style scoped>
.pity-indicator {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 180px;
  transition: border-color 0.3s;
}

.pity-indicator.ready {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.08);
}

.pity-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pity-title {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.45);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.pity-count {
  font-size: 0.8rem;
  font-weight: 700;
  color: #ffd700;
}

.pity-indicator:not(.ready) .pity-count {
  color: rgba(255, 255, 255, 0.7);
}

.pity-bar-track {
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.pity-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #f39c12, #e74c3c);
  border-radius: 3px;
  transition: width 0.4s ease;
}

.pity-indicator.ready .pity-bar-fill {
  background: linear-gradient(90deg, #ffd700, #ff9800);
}

.pity-sub {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.3);
}
</style>
