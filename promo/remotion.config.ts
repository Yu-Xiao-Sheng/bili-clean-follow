import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// 本机（Windows + 沙箱）拉不起 Remotion 自带的 chrome-headless-shell，
// 用 REMOTION_BROWSER_EXECUTABLE 指到一个可用的 Chromium（例如 Playwright 的 chromium）。
// CI 上不设这个变量就走 Remotion 自带的 headless shell。
const exec = process.env.REMOTION_BROWSER_EXECUTABLE;
if (exec) {
  Config.setBrowserExecutable(exec);
}