<template>
  <div class="phase-timer" :class="`phase-${lowerPhase}`">
    <div class="phase-info">
      <span class="phase-label">{{ phaseLabel }}</span>
      <span v-if="secsLeft > 0" class="phase-secs">{{ secsLeft }}s</span>
    </div>
    <div class="progress-bar-track" :aria-hidden="true">
      <div
        class="progress-bar-fill"
        :style="{ width: progressPct + '%' }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { RoulettePhase } from '@casino/shared';
import { ROULETTE_PHASE_DURATION_MS } from '@casino/shared';

const props = defineProps<{
  phase: RoulettePhase;
  phaseEndsAt: string | null;
}>();

const secsLeft = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const PHASE_LABELS: Record<RoulettePhase, string> = {
  BETTING: '下注中',
  LOCK: '鎖盤',
  RESULT: '開獎',
  COOLDOWN: '冷卻中',
};

const lowerPhase = computed(() => props.phase.toLowerCase());
const phaseLabel = computed(() => PHASE_LABELS[props.phase]);

const totalSecs = computed(() => {
  const ms = ROULETTE_PHASE_DURATION_MS[props.phase];
  return Math.ceil(ms / 1000);
});

const progressPct = computed(() => {
  const total = totalSecs.value;
  if (total === 0) return 0;
  return Math.min(100, (secsLeft.value / total) * 100);
});

function calcSecs(): void {
  if (props.phaseEndsAt === null) {
    secsLeft.value = 0;
    return;
  }
  const ms = new Date(props.phaseEndsAt).getTime() - Date.now();
  secsLeft.value = Math.max(0, Math.ceil(ms / 1000));
}

function startTimer(): void {
  stopTimer();
  calcSecs();
  timer = setInterval(calcSecs, 250);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => [props.phase, props.phaseEndsAt] as const,
  () => startTimer(),
  { immediate: true },
);

onUnmounted(stopTimer);
</script>

<style scoped>
.phase-timer {
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.phase-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.phase-label {
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.phase-secs {
  font-size: 0.85rem;
  font-weight: 600;
  opacity: 0.9;
}

.progress-bar-track {
  height: 4px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.25s linear;
}

/* Per-phase colours */
.phase-betting .phase-label { color: #4ade80; }
.phase-betting .progress-bar-fill { background: #4ade80; }

.phase-lock .phase-label { color: #facc15; }
.phase-lock .progress-bar-fill { background: #facc15; }

.phase-result .phase-label { color: #fb923c; }
.phase-result .progress-bar-fill { background: #fb923c; }

.phase-cooldown .phase-label { color: #60a5fa; }
.phase-cooldown .progress-bar-fill { background: #60a5fa; }
</style>
