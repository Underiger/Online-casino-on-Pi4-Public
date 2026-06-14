<template>
  <div>
    <h2 class="page-title">Gift Code 管理</h2>

    <!-- 建立表單 -->
    <div class="card" style="margin-bottom: 20px">
      <h3 class="section-title">產生新禮物碼</h3>
      <div class="create-form">
        <div class="form-group">
          <label>金額</label>
          <input
            v-model.number="form.amount"
            class="form-control"
            type="number"
            min="1"
            placeholder="1000"
          />
        </div>
        <div class="form-group">
          <label>最大使用次數</label>
          <input
            v-model.number="form.maxUses"
            class="form-control"
            type="number"
            min="1"
            placeholder="1"
          />
        </div>
        <div class="form-group">
          <label>有效天數</label>
          <input
            v-model.number="form.expiresInDays"
            class="form-control"
            type="number"
            min="1"
            placeholder="30"
          />
        </div>
        <div class="form-group">
          <label>護符 ID（選填）</label>
          <input
            v-model="form.charmId"
            class="form-control"
            type="text"
            placeholder="charm-uuid 或留空"
          />
        </div>
        <div style="align-self: flex-end">
          <button
            class="btn btn--primary"
            :disabled="createLoading || !form.amount || !form.expiresInDays"
            @click="createCode"
          >
            {{ createLoading ? '產生中…' : '產生禮物碼' }}
          </button>
        </div>
      </div>
      <div v-if="createErr" class="error-msg" style="margin-top: 8px">{{ createErr }}</div>
    </div>

    <!-- 產生成功顯示區 -->
    <Teleport to="body">
      <div v-if="newCode" class="modal-overlay" @click.self="newCode = null">
        <div class="modal">
          <div class="modal__header">🎉 禮物碼產生成功</div>
          <p class="code-warning">⚠️ 此碼僅顯示一次，關閉後無法再查閱！</p>
          <div class="code-display">
            <span class="code-text">{{ newCode.code }}</span>
            <button class="btn btn--ghost btn--sm" @click="copyCode">
              {{ copied ? '✓ 已複製' : '複製' }}
            </button>
          </div>
          <div class="code-info">
            <div>金額：{{ newCode.amount }}</div>
            <div>最大使用：{{ newCode.maxUses }} 次</div>
            <div>到期：{{ fmtDate(newCode.expiresAt) }}</div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--primary" @click="newCode = null">已記錄，關閉</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Gift Code 列表 -->
    <div class="card">
      <h3 class="section-title">已建立的禮物碼</h3>
      <div v-if="listLoading" class="loading-text">載入中…</div>
      <template v-else>
        <div style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>金額</th>
                <th>已用 / 上限</th>
                <th>到期日</th>
                <th>狀態</th>
                <th>建立時間</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in codes" :key="item.id">
                <td style="font-family: monospace; font-weight: 600">{{ item.code }}</td>
                <td>{{ item.amount }}</td>
                <td>{{ item.usedCount }} / {{ item.maxUses }}</td>
                <td>{{ fmtDate(item.expiresAt) }}</td>
                <td>
                  <span
                    class="badge"
                    :class="isExpired(item.expiresAt) ? 'badge--red' : item.usedCount >= item.maxUses ? 'badge--gray' : 'badge--green'"
                  >
                    {{ isExpired(item.expiresAt) ? '已過期' : item.usedCount >= item.maxUses ? '已用完' : '有效' }}
                  </span>
                </td>
                <td>{{ fmtDate(item.createdAt) }}</td>
              </tr>
              <tr v-if="codes.length === 0">
                <td colspan="6" style="text-align: center; color: #94a3b8; padding: 30px">
                  尚無禮物碼
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pagination
          :page="page"
          :total="total"
          :total-pages="totalPages"
          @change="fetchCodes"
        />
      </template>
    </div>

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
  apiCreateGiftCode,
  apiListGiftCodes,
  extractErrorMessage,
  type GiftCodeItem,
} from '../api/admin';
import Pagination from '../components/Pagination.vue';
import ReverifyDialog from '../components/ReverifyDialog.vue';

const auth = useAdminAuthStore();
const ui = useUiStore();

const form = ref({ amount: 1000, maxUses: 1, expiresInDays: 30, charmId: '' });
const createLoading = ref(false);
const createErr = ref('');
const newCode = ref<GiftCodeItem | null>(null);
const copied = ref(false);

const codes = ref<GiftCodeItem[]>([]);
const listLoading = ref(false);
const page = ref(1);
const total = ref(0);
const totalPages = ref(1);

const showReverify = ref(false);
const pendingCreate = ref(false);

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW');
}
function isExpired(iso: string): boolean {
  return Date.now() > new Date(iso).getTime();
}

async function copyCode(): Promise<void> {
  if (!newCode.value) return;
  await navigator.clipboard.writeText(newCode.value.code);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

async function fetchCodes(p = page.value): Promise<void> {
  listLoading.value = true;
  page.value = p;
  try {
    const res = await apiListGiftCodes({ page: p, limit: 20 });
    codes.value = res.items;
    total.value = res.total;
    totalPages.value = Math.ceil(res.total / 20);
  } catch (err) {
    ui.addToast(extractErrorMessage(err), 'error');
  } finally {
    listLoading.value = false;
  }
}

async function createCode(): Promise<void> {
  if (!form.value.amount || !form.value.expiresInDays) return;
  if (!auth.hasValidReverifyToken) {
    pendingCreate.value = true;
    showReverify.value = true;
    return;
  }
  await doCreate();
}

async function onReverified(token: string): Promise<void> {
  showReverify.value = false;
  auth.setReverifyToken(token, 600);
  if (pendingCreate.value) {
    pendingCreate.value = false;
    await doCreate();
  }
}

async function doCreate(): Promise<void> {
  createLoading.value = true;
  createErr.value = '';
  const expiresAt = new Date(Date.now() + form.value.expiresInDays * 86_400_000).toISOString();
  const payload: { amount: number; maxUses: number; expiresAt: string; charmId?: string } = {
    amount: form.value.amount,
    maxUses: form.value.maxUses,
    expiresAt,
  };
  if (form.value.charmId.trim()) payload.charmId = form.value.charmId.trim();

  try {
    const res = await apiCreateGiftCode(payload, auth.reverifyToken!);
    newCode.value = res;
    copied.value = false;
    form.value = { amount: 1000, maxUses: 1, expiresInDays: 30, charmId: '' };
    await fetchCodes(1);
  } catch (err) {
    createErr.value = extractErrorMessage(err);
  } finally {
    createLoading.value = false;
  }
}

onMounted(() => fetchCodes(1));
</script>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
  color: #1e293b;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
  color: #374151;
}
.create-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  align-items: end;
}
.loading-text {
  text-align: center;
  padding: 40px;
  color: #94a3b8;
}
.code-warning {
  color: #d97706;
  font-size: 13px;
  margin-bottom: 16px;
  font-weight: 500;
}
.code-display {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f0fdf4;
  border: 2px solid #16a34a;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.code-text {
  font-family: monospace;
  font-size: 20px;
  font-weight: 700;
  color: #15803d;
  letter-spacing: 2px;
  flex: 1;
}
.code-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #64748b;
  flex-wrap: wrap;
}
</style>
