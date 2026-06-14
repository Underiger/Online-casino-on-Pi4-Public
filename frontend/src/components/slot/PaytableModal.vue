<script setup lang="ts">
/**
 * PaytableModal（M12）：
 * 彈窗顯示老虎機符號賠率表，資料從 GET /api/slot/paytable 取得。
 */
import { ref, onMounted } from 'vue';
import { SlotSymbol } from '@casino/shared';
import type { SlotPaytableRes, PaytableEntry } from '@casino/shared';

interface SymbolDisplay {
  text: string;
  isText: boolean;
}

const SYMBOL_DISPLAY: Record<SlotSymbol, SymbolDisplay> = {
  [SlotSymbol.CHERRY]:  { text: '🍒', isText: false },
  [SlotSymbol.LEMON]:   { text: '🍋', isText: false },
  [SlotSymbol.BELL]:    { text: '🔔', isText: false },
  [SlotSymbol.BAR]:     { text: 'BAR', isText: true },
  [SlotSymbol.CLOVER]:  { text: '🍀', isText: false },
  [SlotSymbol.LUCKY7]:  { text: '7',  isText: true },
  [SlotSymbol.DIAMOND]: { text: '💎', isText: false },
  [SlotSymbol.WILD]:    { text: '⭐', isText: false },
};

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const loading = ref(false);
const fetchError = ref<string | null>(null);
const paytableData = ref<SlotPaytableRes | null>(null);

function close(): void {
  emit('update:modelValue', false);
}

async function fetchPaytable(): Promise<void> {
  if (paytableData.value !== null) return;
  loading.value = true;
  fetchError.value = null;
  try {
    const { apiGetPaytable } = await import('../../api/endpoints/slot');
    paytableData.value = await apiGetPaytable();
  } catch {
    fetchError.value = '無法載入賠率表，請稍後再試。';
  } finally {
    loading.value = false;
  }
}

onMounted(fetchPaytable);

function symbolText(entry: PaytableEntry): string {
  return SYMBOL_DISPLAY[entry.symbol].text;
}

function isTextSymbol(entry: PaytableEntry): boolean {
  return SYMBOL_DISPLAY[entry.symbol].isText;
}

function hasLuckyBonus(entry: PaytableEntry): boolean {
  return paytableData.value?.luckySymbol === entry.symbol;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="modelValue" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="賠率表" @click.self="close">
        <div class="modal-panel">
          <div class="modal-header">
            <h2 class="modal-title">賠率表</h2>
            <button class="close-btn" aria-label="關閉" @click="close">✕</button>
          </div>

          <div class="modal-body">
            <!-- 載入中 -->
            <div v-if="loading" class="status-msg">載入中…</div>

            <!-- 錯誤 -->
            <div v-else-if="fetchError !== null" class="status-msg error">{{ fetchError }}</div>

            <!-- 賠率表內容 -->
            <template v-else-if="paytableData !== null">
              <!-- 今日幸運符號提示 -->
              <div v-if="paytableData.luckySymbol !== null" class="lucky-banner">
                🌟 今日幸運符號：
                <span class="lucky-sym">
                  {{ SYMBOL_DISPLAY[paytableData.luckySymbol].text }}
                </span>
                命中時賠率 ×{{ paytableData.luckyMultiplierBonus }}
              </div>

              <table class="paytable">
                <thead>
                  <tr>
                    <th>符號</th>
                    <th>名稱</th>
                    <th>三連倍率</th>
                    <th>二連倍率</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="entry in paytableData.entries"
                    :key="entry.symbol"
                    :class="{ 'lucky-row': hasLuckyBonus(entry), 'wild-row': entry.isWild }"
                  >
                    <td class="sym-cell">
                      <span :class="['sym-icon', { 'is-text': isTextSymbol(entry) }]">
                        {{ symbolText(entry) }}
                      </span>
                    </td>
                    <td class="name-cell">
                      {{ entry.symbol }}
                      <span v-if="entry.isWild" class="badge wild">WILD</span>
                      <span v-if="hasLuckyBonus(entry)" class="badge lucky">🌟 TODAY</span>
                    </td>
                    <td class="mult-cell">×{{ entry.tripleMultiplier }}</td>
                    <td class="mult-cell">
                      <span v-if="entry.doubleMultiplier !== null">×{{ entry.doubleMultiplier }}</span>
                      <span v-else class="na">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <p class="note">* Wild 三連賠率最高；二連賠付僅限 CHERRY。</p>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  padding: 1rem;
}

.modal-panel {
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 100%);
  border: 1px solid rgba(255, 215, 0, 0.3);
  border-radius: 14px;
  width: 100%;
  max-width: 480px;
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid rgba(255, 215, 0, 0.15);
}

.modal-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #ffd700;
  margin: 0;
}

.close-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: color 0.2s;
}

.close-btn:hover {
  color: #fff;
}

.modal-body {
  padding: 1rem 1.25rem;
  overflow-y: auto;
}

.status-msg {
  text-align: center;
  color: rgba(255, 255, 255, 0.6);
  padding: 2rem 0;
}

.status-msg.error {
  color: #e74c3c;
}

.lucky-banner {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: rgba(255, 215, 0, 0.1);
  border: 1px solid rgba(255, 215, 0, 0.3);
  border-radius: 8px;
  padding: 0.55rem 0.75rem;
  font-size: 0.85rem;
  color: #ffd700;
  margin-bottom: 0.9rem;
}

.lucky-sym {
  font-size: 1.2rem;
  vertical-align: middle;
}

.paytable {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.paytable th {
  text-align: left;
  color: rgba(255, 255, 255, 0.5);
  font-weight: 600;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.paytable tbody tr {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  transition: background 0.15s;
}

.paytable tbody tr:hover {
  background: rgba(255, 255, 255, 0.04);
}

.paytable tbody tr.lucky-row {
  background: rgba(255, 215, 0, 0.06);
}

.paytable tbody tr.wild-row {
  background: rgba(255, 200, 0, 0.04);
}

.sym-cell {
  padding: 0.55rem 0.5rem;
  width: 52px;
}

.sym-icon {
  font-size: 1.5rem;
  line-height: 1;
}

.sym-icon.is-text {
  font-size: 1rem;
  font-weight: 900;
  color: #3498db;
}

.name-cell {
  padding: 0.55rem 0.5rem;
  color: rgba(255, 255, 255, 0.85);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.mult-cell {
  padding: 0.55rem 0.5rem;
  font-weight: 600;
  color: #ffd700;
  text-align: right;
}

.na {
  color: rgba(255, 255, 255, 0.25);
  font-weight: 400;
}

.badge {
  font-size: 0.65rem;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.badge.wild {
  background: rgba(255, 215, 0, 0.2);
  color: #ffd700;
}

.badge.lucky {
  background: rgba(255, 215, 0, 0.15);
  color: #ffd700;
}

.note {
  margin-top: 0.8rem;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.3);
  line-height: 1.5;
}

/* Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .modal-panel,
.modal-leave-active .modal-panel {
  transition: transform 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-panel {
  transform: scale(0.96) translateY(8px);
}

.modal-leave-to .modal-panel {
  transform: scale(0.96) translateY(8px);
}
</style>
