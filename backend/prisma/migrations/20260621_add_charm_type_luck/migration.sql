-- 新增護符類型 LUCK：機率觸發、鎖定第3軸覆寫為目標符號（不動權重，與 p³ 連線機率解耦）。
-- 取代 5 顆 WEIGHT 護符（CLOVER_BOOST_30/BELL_TUNER_30/BAR_MAGNET_35/SEVEN_CALLER_25/
-- DIAMOND_DUST_20）原本的權重乘數機制——該機制稀釋櫻桃權重導致裝備時 RTP 暴跌
-- （Monte Carlo 驗證：luck=1 顆鎖軸即可讓 RTP 從 91.5% 崩到 15~26%）。
-- 純新增列舉值，不影響既有資料列、不需要重寫資料表（同 20260621_add_gacha_tx_type 模式）。
ALTER TYPE "CharmType" ADD VALUE 'LUCK';
