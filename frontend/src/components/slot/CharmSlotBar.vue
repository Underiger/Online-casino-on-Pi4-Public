<script setup lang="ts">
/**
 * CharmSlotBar（M13）：三個護符裝備槽。
 * 空槽 → 點擊「+」開啟選擇面板；已裝備 → 顯示護符資訊 + 「✕」卸下。
 */
import { ref, computed } from 'vue';
import { CharmRarity, CharmType, CHARM_MAX_SLOTS } from '@casino/shared';
import type { UserCharmItem } from '@casino/shared';
import { useCharmStore } from '../../stores/charm';

const emit = defineEmits<{
  (e: 'toast', msg: string): void;
}>();

const charmStore = useCharmStore();

// 目前開啟選擇面板的槽位（null = 全關）
const openPickerSlot = ref<number | null>(null);

const slots = Array.from({ length: CHARM_MAX_SLOTS }, (_, i) => i + 1) as [1, 2, 3];

// 各槽位的已裝備護符
function equippedAt(slot: number): UserCharmItem | undefined {
  return charmStore.equippedBySlot.get(slot);
}

// 未裝備、可選清單（供 picker 使用）
const pickerItems = computed(() => charmStore.available);

// 稀有度樣式 key
const RARITY_CLASS: Record<CharmRarity, string> = {
  [CharmRarity.COMMON]: 'rarity-common',
  [CharmRarity.RARE]: 'rarity-rare',
  [CharmRarity.EPIC]: 'rarity-epic',
  [CharmRarity.LEGENDARY]: 'rarity-legendary',
};

// 類型圖示
const TYPE_ICON: Record<CharmType, string> = {
  [CharmType.WEIGHT]: '⚖️',
  [CharmType.RULE]: '📜',
  [CharmType.CONDITIONAL]: '🎲',
  [CharmType.PITY]: '🛡',
  [CharmType.BONUS]: '💎',
};

function rarityClass(rarity: string): string {
  return RARITY_CLASS[rarity as CharmRarity] ?? 'rarity-common';
}

function typeIcon(type: string): string {
  return TYPE_ICON[type as CharmType] ?? '🔮';
}

function togglePicker(slot: number): void {
  openPickerSlot.value = openPickerSlot.value === slot ? null : slot;
}

function closePicker(): void {
  openPickerSlot.value = null;
}

async function handleEquip(userCharmId: string, slot: number): Promise<void> {
  closePicker();
  await charmStore.equipCharm(userCharmId, slot);
  if (charmStore.error !== null) {
    emit('toast', charmStore.error);
  } else {
    emit('toast', `護符已裝備到槽位 ${slot}`);
  }
}

async function handleUnequip(slot: number): Promise<void> {
  await charmStore.unequipCharm(slot);
  if (charmStore.error !== null) {
    emit('toast', charmStore.error);
  } else {
    emit('toast', `槽位 ${slot} 護符已卸下`);
  }
}
</script>

<template>
  <div class="charm-bar" role="region" aria-label="護符裝備欄">
    <span class="charm-label">護符</span>

    <div class="charm-slots">
      <div
        v-for="slot in slots"
        :key="slot"
        class="charm-slot-wrap"
      >
        <!-- 已裝備：顯示護符資訊 -->
        <div
          v-if="equippedAt(slot) !== undefined"
          class="charm-slot equipped"
          :class="rarityClass(equippedAt(slot)!.charm.rarity)"
          :title="equippedAt(slot)!.charm.description"
        >
          <span class="charm-type-icon">{{ typeIcon(equippedAt(slot)!.charm.type) }}</span>
          <span class="charm-name-text">{{ equippedAt(slot)!.charm.name }}</span>
          <button
            class="unequip-btn"
            :aria-label="`卸下槽位 ${slot} 的 ${equippedAt(slot)!.charm.name}`"
            :disabled="charmStore.loading"
            @click.stop="handleUnequip(slot)"
          >✕</button>
        </div>

        <!-- 空槽：點擊開啟選擇器 -->
        <button
          v-else
          class="charm-slot empty"
          :class="{ 'picker-open': openPickerSlot === slot }"
          :aria-label="`槽位 ${slot}：點擊裝備護符`"
          :aria-expanded="openPickerSlot === slot"
          @click="togglePicker(slot)"
        >
          <span class="add-icon">+</span>
          <span class="slot-num">槽 {{ slot }}</span>
        </button>

        <!-- 選擇面板 -->
        <Transition name="picker">
          <div
            v-if="openPickerSlot === slot"
            class="picker-panel"
            role="listbox"
            :aria-label="`選擇裝備到槽位 ${slot} 的護符`"
          >
            <div class="picker-header">
              <span>選擇護符</span>
              <button class="picker-close" aria-label="關閉" @click="closePicker">✕</button>
            </div>

            <div v-if="charmStore.loading" class="picker-empty">載入中…</div>

            <div v-else-if="pickerItems.length === 0" class="picker-empty">
              暫無可用護符
            </div>

            <ul v-else class="picker-list">
              <li
                v-for="item in pickerItems"
                :key="item.id"
                class="picker-item"
                :class="rarityClass(item.charm.rarity)"
                role="option"
                :aria-selected="false"
                tabindex="0"
                @click="handleEquip(item.id, slot)"
                @keydown.enter="handleEquip(item.id, slot)"
              >
                <span class="picker-type-icon">{{ typeIcon(item.charm.type) }}</span>
                <div class="picker-info">
                  <span class="picker-name">{{ item.charm.name }}</span>
                  <span class="picker-desc">{{ item.charm.description }}</span>
                </div>
                <span class="picker-rarity-badge">{{ item.charm.rarity }}</span>
              </li>
            </ul>
          </div>
        </Transition>
      </div>
    </div>
  </div>

  <!-- 點擊面板外 → 關閉 -->
  <Teleport to="body">
    <div
      v-if="openPickerSlot !== null"
      class="picker-backdrop"
      aria-hidden="true"
      @click="closePicker"
    />
  </Teleport>
</template>

<style scoped>
.charm-bar {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  position: relative;
}

.charm-label {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  padding-top: 0.4rem;
}

.charm-slots {
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.charm-slot-wrap {
  position: relative;
}

/* ── 公共槽位樣式 ── */
.charm-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 60px;
  min-height: 64px;
  border-radius: 8px;
  font-size: 0.68rem;
  padding: 4px;
  box-sizing: border-box;
  transition: border-color 0.2s, background 0.2s;
}

/* ── 空槽 ── */
.charm-slot.empty {
  border: 1px dashed rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
}

.charm-slot.empty:hover,
.charm-slot.empty.picker-open {
  border-color: rgba(255, 215, 0, 0.45);
  background: rgba(255, 215, 0, 0.07);
  color: #ffd700;
}

.add-icon {
  font-size: 1.3rem;
  font-weight: 300;
  line-height: 1;
}

.slot-num {
  font-size: 0.6rem;
  opacity: 0.6;
}

/* ── 已裝備槽 ── */
.charm-slot.equipped {
  border: 1px solid;
  position: relative;
  cursor: default;
}

.charm-type-icon {
  font-size: 1.2rem;
  line-height: 1;
}

.charm-name-text {
  font-size: 0.6rem;
  text-align: center;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unequip-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(220, 50, 50, 0.85);
  color: #fff;
  font-size: 0.6rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  transition: background 0.15s;
}

.unequip-btn:hover:not(:disabled) {
  background: #e74c3c;
}

.unequip-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── 稀有度邊框色 ── */
.rarity-common  { border-color: rgba(160, 160, 160, 0.6); color: rgba(255,255,255,0.75); }
.rarity-rare    { border-color: rgba(59, 130, 246, 0.7);  color: #93c5fd; }
.rarity-epic    { border-color: rgba(167, 103, 243, 0.8); color: #c4b5fd; }
.rarity-legendary { border-color: rgba(255, 215, 0, 0.9); color: #ffd700; }

/* ── 選擇面板 ── */
.picker-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: 240px;
  background: #1a1a2e;
  border: 1px solid rgba(255, 215, 0, 0.3);
  border-radius: 10px;
  z-index: 300;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.7);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.picker-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.45);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  line-height: 1;
  transition: color 0.15s;
}

.picker-close:hover { color: #fff; }

.picker-empty {
  padding: 1rem 0.75rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
}

.picker-list {
  list-style: none;
  margin: 0;
  padding: 0.3rem 0;
  max-height: 220px;
  overflow-y: auto;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
  transition: background 0.15s;
  outline: none;
}

.picker-item:hover,
.picker-item:focus {
  background: rgba(255, 255, 255, 0.07);
}

.picker-type-icon { font-size: 1rem; flex-shrink: 0; }

.picker-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.picker-name {
  font-size: 0.78rem;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-desc {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-rarity-badge {
  font-size: 0.58rem;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  flex-shrink: 0;
}

.picker-item.rarity-rare    .picker-name { color: #93c5fd; }
.picker-item.rarity-epic    .picker-name { color: #c4b5fd; }
.picker-item.rarity-legendary .picker-name { color: #ffd700; }

/* ── 動畫 ── */
.picker-enter-active { transition: opacity 0.15s, transform 0.15s; }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s; }
.picker-enter-from,
.picker-leave-to { opacity: 0; transform: translateY(6px); }

/* ── 遮罩（接收 body 點擊來關閉面板）── */
.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 299;
}
</style>
