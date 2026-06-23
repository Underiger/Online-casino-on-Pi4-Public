<template>
  <div>
    <h2 class="page-title">紀錄查詢</h2>

    <!-- 頁籤 -->
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ 'tab--active': activeTab === tab.key }"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 共用篩選列 -->
    <div class="card" style="margin-bottom: 16px">
      <div class="filters">
        <input
          v-model="filterUserId"
          class="form-control"
          style="max-width: 240px"
          type="text"
          placeholder="使用者 ID 或名稱…"
        />
        <input
          v-model="filterFrom"
          class="form-control"
          type="datetime-local"
          style="max-width: 200px"
        />
        <span style="color: #94a3b8">至</span>
        <input
          v-model="filterTo"
          class="form-control"
          type="datetime-local"
          style="max-width: 200px"
        />

        <!-- 登入紀錄額外篩選 -->
        <template v-if="activeTab === 'login'">
          <select v-model="filterResult" class="form-control" style="max-width: 140px">
            <option value="">全部結果</option>
            <option value="SUCCESS">成功</option>
            <option value="WRONG_PASSWORD">密碼錯誤</option>
            <option value="BANNED">帳號封鎖</option>
            <option value="TOTP_FAILED">TOTP 失敗</option>
          </select>
        </template>

        <!-- 下注紀錄額外篩選 -->
        <template v-if="activeTab === 'bets'">
          <select v-model="filterGameType" class="form-control" style="max-width: 120px">
            <option value="">全部遊戲</option>
            <option value="SLOT">老虎機</option>
            <option value="ROULETTE">輪盤</option>
          </select>
        </template>

        <!-- 交易紀錄額外篩選 -->
        <template v-if="activeTab === 'transactions'">
          <select v-model="filterTxType" class="form-control" style="max-width: 150px">
            <option value="">全部類型</option>
            <option value="BET">下注</option>
            <option value="PAYOUT">派彩</option>
            <option value="DAILY_REWARD">每日獎勵</option>
            <option value="TASK_REWARD">任務獎勵</option>
            <option value="GIFT_CODE">禮物碼</option>
            <option value="ADMIN_ADJUST">管理員調整</option>
            <option value="JACKPOT">Jackpot</option>
            <option value="REFUND">退款</option>
            <option value="GACHA">扭蛋</option>
          </select>
        </template>

        <button class="btn btn--primary" :disabled="loading" @click="fetchRecords(1)">查詢</button>
      </div>
    </div>

    <!-- 紀錄表格 -->
    <div class="card">
      <div v-if="loading" class="loading-text">載入中…</div>
      <template v-else>
        <!-- 登入紀錄 -->
        <div v-if="activeTab === 'login'" style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>使用者名稱</th>
                <th>IP</th>
                <th>結果</th>
                <th>User Agent</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in loginRecords" :key="r.id">
                <td style="font-weight: 500">{{ r.username }}</td>
                <td style="font-family: monospace">{{ r.ip }}</td>
                <td>
                  <span
                    class="badge"
                    :class="r.result === 'SUCCESS' ? 'badge--green' : 'badge--red'"
                  >
                    {{ loginResultLabel(r.result) }}
                  </span>
                </td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #94a3b8; font-size: 12px">
                  {{ r.userAgent }}
                </td>
                <td style="white-space: nowrap">{{ fmtDatetime(r.createdAt) }}</td>
              </tr>
              <tr v-if="loginRecords.length === 0">
                <td colspan="5" class="empty-cell">沒有登入紀錄</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 下注紀錄 -->
        <div v-else-if="activeTab === 'bets'" style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>使用者 ID</th>
                <th>遊戲</th>
                <th>下注金額</th>
                <th>派彩金額</th>
                <th>時間</th>
                <th>結果明細</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in betRecords" :key="r.id">
                <td style="font-family: monospace; font-size: 11px; color: #94a3b8">
                  {{ r.userId.slice(0, 8) }}…
                </td>
                <td>
                  <span class="badge badge--gray">{{ r.gameType }}</span>
                </td>
                <td>{{ r.amount }}</td>
                <td :style="{ color: BigInt(r.payout) > BigInt(r.amount) ? '#16a34a' : '#94a3b8' }">
                  {{ r.payout }}
                </td>
                <td style="white-space: nowrap">{{ fmtDatetime(r.createdAt) }}</td>
                <td>
                  <button class="btn btn--ghost btn--sm" @click="toggleDetail(r.id)">
                    {{ expandedId === r.id ? '收起' : '展開' }}
                  </button>
                  <pre v-if="expandedId === r.id" class="detail-pre">{{ JSON.stringify(r.detail, null, 2) }}</pre>
                </td>
              </tr>
              <tr v-if="betRecords.length === 0">
                <td colspan="6" class="empty-cell">沒有下注紀錄</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 交易紀錄 -->
        <div v-else-if="activeTab === 'transactions'" style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>使用者 ID</th>
                <th>類型</th>
                <th>金額</th>
                <th>前餘額</th>
                <th>後餘額</th>
                <th>備註</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in txRecords" :key="r.id">
                <td style="font-family: monospace; font-size: 11px; color: #94a3b8">
                  {{ r.userId.slice(0, 8) }}…
                </td>
                <td>
                  <span class="badge" :class="txTypeBadge(r.type)">{{ r.type }}</span>
                </td>
                <td :style="{ color: r.delta.startsWith('-') ? '#dc2626' : '#16a34a', fontWeight: '600' }">
                  {{ r.delta.startsWith('-') ? r.delta : '+' + r.delta }}
                </td>
                <td>{{ r.balanceBefore }}</td>
                <td>{{ r.balanceAfter }}</td>
                <td style="color: #64748b; font-size: 12px">{{ r.memo ?? '—' }}</td>
                <td style="white-space: nowrap">{{ fmtDatetime(r.createdAt) }}</td>
              </tr>
              <tr v-if="txRecords.length === 0">
                <td colspan="7" class="empty-cell">沒有交易紀錄</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pagination-wrap">
          <Pagination :page="page" :total="total" :total-pages="totalPages" @change="fetchRecords" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUiStore } from '../stores/ui';
import {
  apiListLoginRecords,
  apiListBetRecords,
  apiListTxRecords,
  extractErrorMessage,
  type LoginLogItem,
  type BetRecordItem,
  type TxRecordItem,
} from '../api/admin';
import Pagination from '../components/Pagination.vue';

type TabKey = 'login' | 'bets' | 'transactions';
const tabs = [
  { key: 'login' as const, label: '登入紀錄' },
  { key: 'bets' as const, label: '下注紀錄' },
  { key: 'transactions' as const, label: '交易紀錄' },
];

const ui = useUiStore();
const activeTab = ref<TabKey>('login');
const loading = ref(false);

const filterUserId = ref('');
const filterFrom = ref('');
const filterTo = ref('');
const filterResult = ref('');
const filterGameType = ref('');
const filterTxType = ref('');

const page = ref(1);
const total = ref(0);
const totalPages = ref(1);

const loginRecords = ref<LoginLogItem[]>([]);
const betRecords = ref<BetRecordItem[]>([]);
const txRecords = ref<TxRecordItem[]>([]);
const expandedId = ref<string | null>(null);

function fmtDatetime(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

function loginResultLabel(result: string): string {
  const map: Record<string, string> = {
    SUCCESS: '成功',
    WRONG_PASSWORD: '密碼錯誤',
    BANNED: '帳號封鎖',
    TOTP_FAILED: 'TOTP 失敗',
  };
  return map[result] ?? result;
}

function txTypeBadge(type: string): string {
  if (['BET', 'ADMIN_ADJUST'].includes(type)) return 'badge--red';
  if (['PAYOUT', 'DAILY_REWARD', 'TASK_REWARD', 'GIFT_CODE', 'JACKPOT'].includes(type)) return 'badge--green';
  return 'badge--gray';
}

function toggleDetail(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

function switchTab(tab: TabKey): void {
  activeTab.value = tab;
  page.value = 1;
  loginRecords.value = [];
  betRecords.value = [];
  txRecords.value = [];
  total.value = 0;
  totalPages.value = 1;
  void fetchRecords(1);
}

async function fetchRecords(p = page.value): Promise<void> {
  loading.value = true;
  page.value = p;
  expandedId.value = null;

  const base = {
    page: p,
    limit: 20,
    userId: filterUserId.value || undefined,
    from: filterFrom.value ? new Date(filterFrom.value).toISOString() : undefined,
    to: filterTo.value ? new Date(filterTo.value).toISOString() : undefined,
  };

  try {
    if (activeTab.value === 'login') {
      const res = await apiListLoginRecords({
        ...base,
        result: filterResult.value || undefined,
      });
      loginRecords.value = res.data;
      total.value = res.total;
      totalPages.value = res.totalPages;
    } else if (activeTab.value === 'bets') {
      const res = await apiListBetRecords({
        ...base,
        gameType: filterGameType.value || undefined,
      });
      betRecords.value = res.data;
      total.value = res.total;
      totalPages.value = res.totalPages;
    } else {
      const res = await apiListTxRecords({
        ...base,
        type: filterTxType.value || undefined,
      });
      txRecords.value = res.data;
      total.value = res.total;
      totalPages.value = res.totalPages;
    }
  } catch (err) {
    ui.addToast(extractErrorMessage(err), 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(() => fetchRecords(1));
</script>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
  color: #1e293b;
}
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 2px solid #e2e8f0;
  padding-bottom: 0;
}
.tab {
  padding: 8px 20px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  color: #64748b;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color 0.15s, border-color 0.15s;
}
.tab--active {
  color: #2563eb;
  border-bottom-color: #2563eb;
  font-weight: 600;
}
.filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.loading-text {
  text-align: center;
  padding: 40px;
  color: #94a3b8;
}
.empty-cell {
  text-align: center;
  color: #94a3b8;
  padding: 30px;
}
.detail-pre {
  font-size: 11px;
  background: #f8fafc;
  padding: 8px;
  border-radius: 4px;
  margin-top: 6px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.pagination-wrap {
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
  margin-top: 4px;
}
</style>
