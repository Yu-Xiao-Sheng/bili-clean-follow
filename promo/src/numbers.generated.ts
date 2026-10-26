// 未注入的哨兵文件（stub）。真实取数落地后由 `npm run fill` 覆盖本文件。
// 保持 filled:false 时，两支 v2 影片渲染会在第一帧之前抛错。
export const NUMBERS = {
  filled: false,
  source: "",
  reportGeneratedAt: "",
  tracks: {},
  values: null,
} as const;