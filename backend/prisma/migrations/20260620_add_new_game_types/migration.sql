-- 新增三款莊家 vs 閒家遊戲（射龍門 / High-Low / Blackjack）的 GameType 列舉值。
-- 純新增列舉值，不影響既有資料列、不需要重寫資料表。
ALTER TYPE "GameType" ADD VALUE 'DRAGON_GATE';
ALTER TYPE "GameType" ADD VALUE 'HIGH_LOW';
ALTER TYPE "GameType" ADD VALUE 'BLACKJACK';
