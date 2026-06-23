-- 新增扭蛋機（Gacha）護符抽取的餘額異動類型 GACHA。
-- 純新增列舉值，不影響既有資料列、不需要重寫資料表。
-- 用途：扭蛋扣款（delta < 0，memo「扭蛋抽取」）與重複護符轉換回饋（delta > 0，memo「扭蛋重複轉換」）。
ALTER TYPE "TxType" ADD VALUE 'GACHA';
