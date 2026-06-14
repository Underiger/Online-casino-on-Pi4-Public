<template>
  <div>
    <h2 class="page-title">玩家管理</h2>

    <!-- 搜尋列 -->
    <div class="card" style="margin-bottom: 16px">
      <div class="filters">
        <input
          v-model="searchQ"
          class="form-control"
          style="max-width: 260px"
          type="text"
          placeholder="搜尋使用者名稱…"
          @keyup.enter="fetchPlayers(1)"
        />
        <select v-model="filterBanned" class="form-control" style="max-width: 140px">
          <option value="">全部狀態</option>
          <option value="false">正常</option>
          <option value="true">已封鎖</option>
        </select>
        <button class="btn btn--primary" :disabled="loading" @click="fetchPlayers(1)">搜尋</button>
      </div>
    </div>

    <!-- 玩家列表 -->
    <div class="card">
      <div v-if="loading" class="loading-text">載入中…</div>
      <div v-else-if="players.length === 0" class="empty-text">沒有符合條件的玩家</div>
      <template v-else>
        <div style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>使用者名稱</th>
                <th>餘額</th>
                <th>狀態</th>
                <th>登入連續</th>
                <th>註冊時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in players" :key="p.id">
                <td style="font-family: monospace; font-size: 11px; color: #94a3b8">
                  {{ p.id.slice(0, 8) }}…
                </td>
                <td style="font-weight: 500">{{ p.username }}</td>
                <td>{{ p.balance }}</td>
                <td>
                  <span class="badge" :class="p.banned ? 'badge--red' : 'badge--green'">
                    {{ p.banned ? '封鎖' : '正常' }}
                  </span>
                  <span v-if="p.muted" class="badge badge--gray" style="margin-left: 4px">禁言</span>
                </td>
                <td>{{ p.loginStreak }} 天</td>
                <td>{{ fmtDate(p.createdAt) }}</td>
                <td>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap">
                    <button
                      v-if="!p.banned"
                      class="btn btn--danger btn--sm"
                      @click="openBanDialog(p)"
                    >
                      封鎖
                    </button>
                    <button v-else class="btn btn--success btn--sm" @click="openUnbanDialog(p)">
                      解封
                    </button>
                    <button class="btn btn--ghost btn--sm" @click="openAdjustDialog(p)">
                      調整餘額
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pagination :page="page" :total="total" :total-pages="totalPages" @change="fetchPlayers" />
      </template>
    </div>

    <!-- 封鎖/解封 Dialog -->
    <Teleport to="body">
      <div v-if="banDialog" class="modal-overlay" @click.self="banDialog = null">
        <div class="modal">
          <div class="modal__header">
            {{ banDialog.action === 'ban' ? '封鎖玩家' : '解封玩家' }}
          </div>
          <p style="margin-bottom: 16px; color: #475569">
            確定要{{ banDialog.action === 'ban' ? '封鎖' : '解封' }}
            <strong>{{ banDialog.player.username }}</strong> 嗎？
          </p>
          <div class="form-group">
            <label>原因（選填）</label>
            <input v-model="banReason" class="form-control" type="text" placeholder="封鎖原因…" />
          </div>
          <div v-if="actionErr" class="error-msg" style="margin-bottom: 8px">{{ actionErr }}</div>
          <div class="modal__footer">
            <button class="btn btn--ghost" :disabled="actionLoading" @click="banDialog = null">
              取消
            </button>
            <button
              class="btn"
              :class="banDialog.action === 'ban' ? 'btn--danger' : 'btn--success'"
              :disabled="actionLoading"
              @click="submitBan"
            >
              {{ actionLoading ? '處理中…' : '確認' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 調整餘額 Dialog -->
    <Teleport to="body">
      <div v-if="adjustDialog" class="modal-overlay" @click.self="adjustDialog = null">
        <div class="modal">
          <div class="modal__header">調整餘額 — {{ adjustDialog.username }}</div>
          <div class="form-group">
            <label>調整金額（正數增加，負數扣除）</label>
            <input
              v-model.number="adjustDelta"
              class="form-control"
              type="number"
              placeholder="例如：1000 或 -500"
            />
          </div>
          <div class="form-group">
            <label>原因（必填）</label>
            <input
              v-model="adjustReason"
              class="form-control"
              type="text"
              placeholder="請說明調整原因"
            />
          </div>
          <div v-if="actionErr" class="error-msg" style="margin-bottom: 8px">{{ actionErr }}</div>
          <div class="modal__footer">
            <button class="btn btn--ghost" :disabled="actionLoading" @click="adjustDialog = null">
              取消
            </button>
            <button
              class="btn btn--primary"
              :disabled="actionLoading || adjustDelta === 0 || !adjustReason"
              @click="submitAdjust"
            >
              {{ actionLoading ? '處理中…' : '確認調整' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 2FA 重驗 Dialog -->
    <ReverifyDialog
      v-model="showReverify"
      @verified="onReverified"
      @cancelled="showReverify = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAdminAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import {
  apiListPlayers,
  apiBanUser,
  apiUnbanUser,
  apiAdjustBalance,
  extractErrorMessage,
  type AdminPlayerItem,
} from '../api/admin';
import Pagination from '../components/Pagination.vue';
import ReverifyDialog from '../components/ReverifyDialog.vue';

const auth = useAdminAuthStore();
const ui = useUiStore();

const players = ref<AdminPlayerItem[]>([]);
const total = ref(0);
const totalPages = ref(1);
const page = ref(1);
const loading = ref(false);

const searchQ = ref('');
const filterBanned = ref('');

interface BanDialog {
  player: AdminPlayerItem;
  action: 'ban' | 'unban';
}
const banDialog = ref<BanDialog | null>(null);
const banReason = ref('');

const adjustDialog = ref<AdminPlayerItem | null>(null);
const adjustDelta = ref(0);
const adjustReason = ref('');

const actionLoading = ref(false);
const actionErr = ref('');

const showReverify = ref(false);
type PendingAction = 'ban' | 'unban' | 'adjust';
const pendingAction = ref<PendingAction | null>(null);

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW');
}

async function fetchPlayers(p = page.value): Promise<void> {
  loading.value = true;
  page.value = p;
  try {
    const params: { q?: string; banned?: boolean; page: number; limit: number } = {
      page: p,
      limit: 20,
    };
    if (searchQ.value) params.q = searchQ.value;
    if (filterBanned.value !== '') params.banned = filterBanned.value === 'true';
    const res = await apiListPlayers(params);
    players.value = res.items;
    total.value = res.total;
    totalPages.value = Math.ceil(res.total / 20);
  } catch (err) {
    ui.addToast(extractErrorMessage(err), 'error');
  } finally {
    loading.value = false;
  }
}

function openBanDialog(p: AdminPlayerItem): void {
  banDialog.value = { player: p, action: 'ban' };
  banReason.value = '';
  actionErr.value = '';
}
function openUnbanDialog(p: AdminPlayerItem): void {
  banDialog.value = { player: p, action: 'unban' };
  banReason.value = '';
  actionErr.value = '';
}
function openAdjustDialog(p: AdminPlayerItem): void {
  adjustDialog.value = p;
  adjustDelta.value = 0;
  adjustReason.value = '';
  actionErr.value = '';
}

function requireReverify(action: PendingAction): boolean {
  if (auth.hasValidReverifyToken) return false;
  pendingAction.value = action;
  showReverify.value = true;
  return true;
}

async function onReverified(token: string): Promise<void> {
  showReverify.value = false;
  auth.setReverifyToken(token, 600);
  if (pendingAction.value === 'ban') await submitBan();
  else if (pendingAction.value === 'unban') await submitBan();
  else if (pendingAction.value === 'adjust') await submitAdjust();
  pendingAction.value = null;
}

async function submitBan(): Promise<void> {
  if (!banDialog.value) return;
  if (requireReverify(banDialog.value.action)) return;

  actionLoading.value = true;
  actionErr.value = '';
  const { player, action } = banDialog.value;
  const token = auth.reverifyToken!;
  try {
    if (action === 'ban') {
      await apiBanUser(player.id, token, banReason.value || undefined);
      ui.addToast(`已封鎖 ${player.username}`, 'success');
    } else {
      await apiUnbanUser(player.id, token, banReason.value || undefined);
      ui.addToast(`已解封 ${player.username}`, 'success');
    }
    banDialog.value = null;
    await fetchPlayers();
  } catch (err) {
    actionErr.value = extractErrorMessage(err);
  } finally {
    actionLoading.value = false;
  }
}

async function submitAdjust(): Promise<void> {
  if (!adjustDialog.value) return;
  if (requireReverify('adjust')) return;

  actionLoading.value = true;
  actionErr.value = '';
  const player = adjustDialog.value;
  const token = auth.reverifyToken!;
  try {
    const res = await apiAdjustBalance(player.id, adjustDelta.value, adjustReason.value, token);
    ui.addToast(`已調整 ${player.username} 餘額，新餘額：${res.newBalance}`, 'success');
    adjustDialog.value = null;
    await fetchPlayers();
  } catch (err) {
    actionErr.value = extractErrorMessage(err);
  } finally {
    actionLoading.value = false;
  }
}

onMounted(() => fetchPlayers(1));
</script>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
  color: #1e293b;
}
.filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.loading-text,
.empty-text {
  text-align: center;
  padding: 40px;
  color: #94a3b8;
}
</style>
