<template>
  <div ref="containerRef" class="wheel-container">
    <canvas ref="canvasRef" class="wheel-canvas" />
    <!-- overlay badge for winning number pop -->
    <Transition name="num-pop">
      <div v-if="displayNum !== null" class="num-badge" :class="displayColor">
        {{ displayNum }}
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

// ─── Wheel constants ──────────────────────────────────────────────────────────

/** European roulette wheel order (clockwise from top) */
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function numBaseColor(n: number): string {
  if (n === 0) return '#15803d';
  return RED_NUMBERS.has(n) ? '#b91c1c' : '#1c1917';
}

function numColorClass(n: number): string {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ─── Canvas drawing ────────────────────────────────────────────────────────

const SEGMENTS = WHEEL_ORDER.length; // 37

function drawWheel(
  ctx: CanvasRenderingContext2D,
  size: number,
  highlighted: number | null,
  glowAlpha: number,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.47;
  const textR = outerR * 0.76;
  const innerR = outerR * 0.40;
  const stepAngle = (Math.PI * 2) / SEGMENTS;
  const startOffset = -Math.PI / 2; // first slot at the top

  ctx.clearRect(0, 0, size, size);

  // Gold outer rim
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 4, 0, Math.PI * 2);
  ctx.fillStyle = '#b8960c';
  ctx.fill();

  for (let i = 0; i < SEGMENTS; i++) {
    const n = WHEEL_ORDER[i] as number;
    const startAngle = startOffset + i * stepAngle;
    const endAngle = startAngle + stepAngle;
    const isHighlighted = n === highlighted;

    // Sector fill
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = numBaseColor(n);
    ctx.fill();

    // Highlight overlay (gold pulse)
    if (isHighlighted && glowAlpha > 0) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = `rgba(250, 204, 21, ${0.55 * glowAlpha})`;
      ctx.fill();
    }

    // Divider line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + outerR * Math.cos(startAngle),
      cy + outerR * Math.sin(startAngle),
    );
    ctx.strokeStyle = '#b8960c';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Number text
    const midAngle = startAngle + stepAngle / 2;
    const tx = cx + textR * Math.cos(midAngle);
    const ty = cy + textR * Math.sin(midAngle);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(midAngle + Math.PI / 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, Math.floor(size / 23))}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
  }

  // Inner circle
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR);
  grad.addColorStop(0, '#1e1b4b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#b8960c';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Center gold dot
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
}

// ─── Component ────────────────────────────────────────────────────────────

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let canvasSize = 0;
let animFrameId: number | null = null;
let highlightedNum: number | null = null;
let highlightStartTime = 0;
const HIGHLIGHT_MS = 2500;

const displayNum = ref<number | null>(null);
const displayColor = ref<string>('');

function getCtx(): CanvasRenderingContext2D | null {
  if (ctx !== null) return ctx;
  if (canvasRef.value === null) return null;
  ctx = canvasRef.value.getContext('2d');
  return ctx;
}

function redrawStatic(): void {
  const c = getCtx();
  if (c === null || canvasSize === 0) return;
  drawWheel(c, canvasSize, highlightedNum, 0);
}

function updateSize(): void {
  const container = containerRef.value;
  const canvas = canvasRef.value;
  if (container === null || canvas === null) return;

  const rect = container.getBoundingClientRect();
  const s = Math.floor(Math.min(rect.width, rect.height));
  if (s <= 0 || s === canvasSize) return;

  canvasSize = s;
  canvas.width = s;
  canvas.height = s;
  ctx = null; // invalidated after resize
  redrawStatic();
}

/** Called by RouletteView after RESULT arrives */
function highlightNumber(n: number): void {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  highlightedNum = n;
  highlightStartTime = performance.now();
  displayNum.value = n;
  displayColor.value = numColorClass(n);

  function animate(now: number): void {
    const elapsed = now - highlightStartTime;
    if (elapsed >= HIGHLIGHT_MS) {
      highlightedNum = null;
      displayNum.value = null;
      const c = getCtx();
      if (c !== null) drawWheel(c, canvasSize, null, 0);
      animFrameId = null;
      return;
    }

    const t = elapsed / HIGHLIGHT_MS;
    // Fade-in then fade-out pulse
    const alpha = Math.sin(t * Math.PI);

    const c = getCtx();
    if (c !== null) drawWheel(c, canvasSize, n, alpha);

    animFrameId = requestAnimationFrame(animate);
  }

  animFrameId = requestAnimationFrame(animate);
}

defineExpose({ highlightNumber });

let ro: ResizeObserver | null = null;

onMounted(() => {
  updateSize();
  redrawStatic();

  ro = new ResizeObserver(() => {
    updateSize();
    if (animFrameId === null) redrawStatic();
  });
  if (containerRef.value !== null) ro.observe(containerRef.value);
});

onUnmounted(() => {
  if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  ro?.disconnect();
});
</script>

<style scoped>
.wheel-container {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  max-width: 400px;
  margin: 0 auto;
}

.wheel-canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
}

/* Winning number badge */
.num-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  font-weight: 900;
  color: #ffffff;
  border: 3px solid #fbbf24;
  box-shadow: 0 0 20px rgba(251, 191, 36, 0.8);
  pointer-events: none;
}

.num-badge.red   { background: #b91c1c; }
.num-badge.black { background: #1c1917; }
.num-badge.green { background: #15803d; }

/* Transitions */
.num-pop-enter-active,
.num-pop-leave-active {
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.num-pop-enter-from,
.num-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.4);
}
</style>
