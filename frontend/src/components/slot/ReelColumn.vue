<script setup lang="ts">
/**
 * ReelColumn（M12）：
 * 單軸滾輪元件。isSpinning=true 時快速輪播符號；
 * isSpinning 轉 false 後執行減速停止動畫，最終顯示 finalSymbol，emit spinEnd。
 */
import { ref, watch, computed, onUnmounted } from 'vue';
import { SlotSymbol } from '@casino/shared';

interface SymbolMeta {
  text: string;
  color: string;
  isText: boolean;
}

const SYMBOL_META: Record<SlotSymbol, SymbolMeta> = {
  [SlotSymbol.CHERRY]:  { text: '🍒', color: '#e74c3c', isText: false },
  [SlotSymbol.LEMON]:   { text: '🍋', color: '#f1c40f', isText: false },
  [SlotSymbol.BELL]:    { text: '🔔', color: '#f39c12', isText: false },
  [SlotSymbol.BAR]:     { text: 'BAR', color: '#3498db', isText: true },
  [SlotSymbol.CLOVER]:  { text: '🍀', color: '#27ae60', isText: false },
  [SlotSymbol.LUCKY7]:  { text: '7',   color: '#9b59b6', isText: true },
  [SlotSymbol.DIAMOND]: { text: '💎', color: '#00bcd4', isText: false },
  [SlotSymbol.WILD]:    { text: '⭐', color: '#ffd700', isText: false },
};

const ALL_SYMBOLS = Object.values(SlotSymbol);

const props = withDefaults(defineProps<{
  /** 停止後顯示的符號 */
  finalSymbol: SlotSymbol | null;
  /** true=開始旋轉；false=觸發停止動畫 */
  isSpinning: boolean;
  /** 減速動畫總時長（ms），控制整體節奏 */
  duration?: number;
}>(), {
  finalSymbol: null,
  duration: 900,
});

const emit = defineEmits<{
  spinEnd: [];
}>();

const displaySymbol = ref<SlotSymbol>(SlotSymbol.CHERRY);
const isDecelerating = ref(false);

let spinTimer: ReturnType<typeof setInterval> | null = null;
let decelTimer: ReturnType<typeof setTimeout> | null = null;

function randomSymbol(): SlotSymbol {
  return ALL_SYMBOLS[Math.floor(Math.random() * ALL_SYMBOLS.length)] as SlotSymbol;
}

function clearAll(): void {
  if (spinTimer !== null) { clearInterval(spinTimer); spinTimer = null; }
  if (decelTimer !== null) { clearTimeout(decelTimer); decelTimer = null; }
}

function startSpinning(): void {
  clearAll();
  isDecelerating.value = false;
  spinTimer = setInterval(() => {
    displaySymbol.value = randomSymbol();
  }, 80);
}

function stopSpinning(final: SlotSymbol): void {
  clearAll();
  isDecelerating.value = true;

  // 減速序列：間隔逐漸拉長，最後停在 finalSymbol
  const unit = props.duration / 6;
  const delays = [unit, unit * 1.4, unit * 1.8, unit * 2.2];
  let step = 0;

  function tick(): void {
    if (step < delays.length - 1) {
      displaySymbol.value = randomSymbol();
      step++;
      decelTimer = setTimeout(tick, delays[step]);
    } else {
      displaySymbol.value = final;
      isDecelerating.value = false;
      emit('spinEnd');
    }
  }

  decelTimer = setTimeout(tick, delays[0]);
}

watch(
  () => props.isSpinning,
  (spinning, was) => {
    if (spinning && !was) {
      startSpinning();
    } else if (!spinning && was) {
      stopSpinning(props.finalSymbol ?? displaySymbol.value);
    }
  },
);

onUnmounted(clearAll);

const meta = computed(() => SYMBOL_META[displaySymbol.value]);
const isActive = computed(() => props.isSpinning || isDecelerating.value);
</script>

<template>
  <div class="reel-column" :class="{ active: isActive }">
    <div class="reel-window">
      <span
        class="symbol"
        :class="{ 'is-text': meta.isText, blurring: isActive }"
        :style="{ color: meta.color }"
      >{{ meta.text }}</span>
    </div>
    <div class="symbol-label">{{ displaySymbol }}</div>
  </div>
</template>

<style scoped>
.reel-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 110px;
}

.reel-window {
  width: 110px;
  height: 110px;
  border-radius: 12px;
  border: 2px solid rgba(255, 215, 0, 0.25);
  background: linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(20,20,40,0.9) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.reel-column.active .reel-window {
  border-color: #ffd700;
  box-shadow: 0 0 12px rgba(255, 215, 0, 0.4);
}

.symbol {
  font-size: 3.2rem;
  line-height: 1;
  user-select: none;
  transition: filter 0.06s ease;
}

.symbol.is-text {
  font-size: 2rem;
  font-weight: 900;
  letter-spacing: 0.05em;
}

.symbol.blurring {
  filter: blur(3px);
}

.symbol-label {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
</style>
