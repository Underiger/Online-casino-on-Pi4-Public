<template>
  <div class="chip-selector" role="group" aria-label="選擇籌碼金額">
    <button
      v-for="value in CHIP_VALUES"
      :key="value"
      class="chip"
      :class="{ active: modelValue === value }"
      :aria-pressed="modelValue === value"
      @click="emit('update:modelValue', value)"
    >
      <span class="chip-inner">
        <span class="chip-amount">{{ value }}</span>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
/** Chip values available in roulette (05_MILESTONES M16 spec) */
const CHIP_VALUES = [10, 50, 100, 500] as const;

defineProps<{
  modelValue: number;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();
</script>

<style scoped>
.chip-selector {
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 8px 0;
}

.chip {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: transform 0.15s ease;
}

.chip:hover {
  transform: translateY(-3px);
}

.chip.active .chip-inner {
  background: radial-gradient(circle at 35% 35%, #fef08a, #ca8a04, #78350f);
  border-color: #fef08a;
  box-shadow: 0 0 0 3px rgba(254, 240, 138, 0.5), 0 4px 12px rgba(0, 0, 0, 0.5);
}

.chip-inner {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 3px dashed rgba(255, 255, 255, 0.35);
  background: radial-gradient(circle at 35% 35%, #94a3b8, #475569, #1e293b);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
  transition: all 0.15s ease;
}

.chip-amount {
  font-size: 0.85rem;
  font-weight: 700;
  color: #f8fafc;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  letter-spacing: -0.02em;
}

@media (max-width: 400px) {
  .chip-inner {
    width: 46px;
    height: 46px;
  }
  .chip-amount {
    font-size: 0.75rem;
  }
}
</style>
