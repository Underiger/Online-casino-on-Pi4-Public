/**
 * @casino/shared — 前後端共用型別的單一真值來源。
 *
 * M05（API 與 Socket 事件規格凍結）產出：
 *   - dto/              各 API request/response 型別（含 zod schema）
 *   - socket-events.ts  事件名稱常數 + payload 型別 + Typed Events 介面
 *   - enums.ts          與 Prisma enum 對齊的所有列舉
 *   - constants.ts      注額檔位、訊息長度上限等共用常數
 */

export * from './enums';
export * from './constants';
export * from './socket-events';
export * from './dto/index';
