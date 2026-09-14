/**
 * 状态栏状态机 —— 纯函数，不 import vscode。
 *
 * 颜色以 ThemeColor 的字符串 id 返回，由 StatusBarController 负责实例化。
 * tooltip 也在这里生成成 markdown 字符串，所以整张状态表都能在纯 Node 下单测。
 */

import {
  formatAmount,
  formatDetailed,
  isLow,
  selectInfo,
  type CurrencyPref,
} from "./deepseek/balance";
import type { BalanceError, BalanceSnapshot } from "./deepseek/types";

export const COMMAND_REFRESH = "deepseekBalance.refresh";
export const COMMAND_SHOW_DETAILS = "deepseekBalance.showDetails";
export const COMMAND_SET_API_KEY = "deepseekBalance.setApiKey";
export const COMMAND_CLEAR_API_KEY = "deepseekBalance.clearApiKey";
export const COMMAND_OPEN_SETTINGS = "deepseekBalance.openSettings";

/** tooltip 里允许点击的命令白名单——绝不能改成 isTrusted: true。 */
export const ALL_COMMANDS: readonly string[] = [
  COMMAND_REFRESH,
  COMMAND_SHOW_DETAILS,
  COMMAND_SET_API_KEY,
  COMMAND_CLEAR_API_KEY,
  COMMAND_OPEN_SETTINGS,
];

const WARNING_FG = "statusBarItem.warningForeground";
const WARNING_BG = "statusBarItem.warningBackground";
const ERROR_FG = "statusBarItem.errorForeground";
const ERROR_BG = "statusBarItem.errorBackground";

/** 只有这两个背景色 id 在多数主题下真正生效。 */
export const ALERT_BACKGROUNDS: readonly string[] = [WARNING_BG, ERROR_BG];

export interface RenderOptions {
  currency: CurrencyPref;
  lowBalanceThreshold: number;
}

export type StatusState =
  | { kind: "no-key" }
  | { kind: "loading"; previous?: BalanceSnapshot }
  | { kind: "ok"; snapshot: BalanceSnapshot; stale: boolean }
  | {
      kind: "error";
      error: BalanceError;
      previous?: BalanceSnapshot;
      stale: boolean;
    };

export interface StatusViewModel {
  text: string;
  tooltip: string;
  colorId?: string;
  backgroundColorId?: string;
  command: string;
  accessibleLabel: string;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

type Section = string[] | undefined;

function assemble(sections: readonly Section[]): string {
  return sections
    .filter((section): section is string[] => section !== undefined && section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n");
}

function actions(...pairs: readonly (readonly [string, string])[]): string[] {
  return [pairs.map(([label, command]) => `[${label}](command:${command})`).join(" · ")];
}

/** 状态栏要显示的那一条金额；没有余额信息时返回 undefined。 */
function headline(
  snapshot: BalanceSnapshot,
  options: RenderOptions,
): string | undefined {
  const info = selectInfo(snapshot.infos, options.currency);
  return info === undefined ? undefined : formatAmount(info);
}

function balanceLines(snapshot: BalanceSnapshot): string[] {
  if (snapshot.infos.length === 0) return ["（无余额信息）"];
  return snapshot.infos.map(formatDetailed);
}

function snapshotSection(snapshot: BalanceSnapshot): string[] {
  return [
    ...balanceLines(snapshot),
    "",
    snapshot.isAvailable
      ? "$(check) 账户状态：可用"
      : "$(circle-slash) 账户状态：不可用于 API 调用",
    `$(history) 上次更新：${formatTime(snapshot.fetchedAt)}`,
    `$(server) 接口地址：${snapshot.endpoint}`,
  ];
}

const DEFAULT_ACTIONS = actions(
  ["立即刷新", COMMAND_REFRESH],
  ["查看详情", COMMAND_SHOW_DETAILS],
  ["设置", COMMAND_OPEN_SETTINGS],
);

export function render(
  state: StatusState,
  options: RenderOptions,
): StatusViewModel {
  switch (state.kind) {
    case "no-key":
      return {
        text: "$(key) DeepSeek",
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          ["尚未配置 API Key。"],
          actions(["设置 API Key", COMMAND_SET_API_KEY]),
        ]),
        command: COMMAND_SET_API_KEY,
        accessibleLabel: "DeepSeek 余额：尚未配置 API Key",
      };

    case "loading": {
      const previous = state.previous;
      const amount = previous === undefined ? undefined : headline(previous, options);
      return {
        text: amount === undefined ? "$(sync~spin) DeepSeek" : `$(sync~spin) ${amount}`,
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          [
            "正在刷新…",
            ...(previous === undefined
              ? []
              : [`上次成功获取：${formatTime(previous.fetchedAt)}`]),
          ],
          previous === undefined ? undefined : snapshotSection(previous),
          DEFAULT_ACTIONS,
        ]),
        command: COMMAND_REFRESH,
        accessibleLabel: "DeepSeek 余额：正在刷新",
      };
    }

    case "ok": {
      const { snapshot, stale } = state;
      const amount = headline(snapshot, options);
      const info = selectInfo(snapshot.infos, options.currency);

      let text: string;
      let colorId: string | undefined;
      let backgroundColorId: string | undefined;
      let notes: string[] | undefined;
      let label: string;

      if (!snapshot.isAvailable) {
        // 钱还在，只是不能用于 API 调用——独立成一态，不并进通用错误。
        text = `$(circle-slash) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        backgroundColorId = WARNING_BG;
        notes = [
          "**账户余额当前不可用**（is_available 为 false）：资金仍然存在，但无法用于 API 调用，请检查账户状态。",
        ];
        label = "DeepSeek 余额：账户余额当前不可用于 API 调用";
      } else if (isLow(info, options.lowBalanceThreshold)) {
        text = `$(warning) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        backgroundColorId = WARNING_BG;
        notes = [
          `**$(warning) 余额低于阈值 ${options.lowBalanceThreshold}，请及时充值。**`,
        ];
        label = `DeepSeek 余额：${amount ?? "未知"}，低于告警阈值`;
      } else if (stale) {
        // 只改前景色，不设背景——过期是「提醒」不是「告警」。
        text = `$(warning) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        notes = [
          `$(warning) 数据可能已过期（上次成功获取：${formatTime(snapshot.fetchedAt)}）。`,
        ];
        label = `DeepSeek 余额：${amount ?? "未知"}，数据可能已过期`;
      } else {
        text = `$(credit-card) ${amount ?? "DeepSeek"}`;
        label = `DeepSeek 余额：${amount ?? "无余额信息"}`;
      }

      return {
        text,
        tooltip: assemble([["**DeepSeek 账户余额**"], notes, snapshotSection(snapshot), DEFAULT_ACTIONS]),
        ...(colorId === undefined ? {} : { colorId }),
        ...(backgroundColorId === undefined ? {} : { backgroundColorId }),
        command: COMMAND_REFRESH,
        accessibleLabel: label,
      };
    }

    case "error": {
      const { error, previous } = state;
      const previousAmount =
        previous === undefined ? undefined : headline(previous, options);
      const isAuth = error.kind === "unauthorized" || error.kind === "forbidden";

      let text: string;
      let colorId = WARNING_FG;
      let backgroundColorId: string | undefined;
      let command = COMMAND_REFRESH;
      let label: string;

      if (isAuth) {
        // 密钥无效时状态栏不留旧数字——旁边挂个过期数字容易被误读。
        // 旧值仍然出现在 tooltip 里，并标注已过期。
        text = "$(error) DeepSeek 密钥无效";
        colorId = ERROR_FG;
        backgroundColorId = ERROR_BG;
        command = COMMAND_SET_API_KEY;
        label = "DeepSeek 余额：API Key 无效";
      } else if (previousAmount !== undefined) {
        // 保留最后已知良好值，避免一次网络抖动就把状态栏清空。
        text = `$(warning) ${previousAmount}`;
        label = `DeepSeek 余额：${previousAmount}，刷新失败`;
      } else if (error.kind === "malformed") {
        text = "$(warning) DeepSeek 数据异常";
        label = "DeepSeek 余额：接口数据异常";
      } else {
        text = "$(warning) DeepSeek 连接失败";
        label = "DeepSeek 余额：连接失败";
      }

      const staleNote =
        isAuth && previous !== undefined
          ? `$(warning) 上次成功获取的值：${headline(previous, options) ?? "（无余额信息）"}（已过期）`
          : undefined;

      return {
        text,
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          [`**$(error) ${error.message}**`],
          ...(staleNote === undefined ? [] : [[staleNote] as string[]]),
          ...(error.httpStatus === undefined
            ? []
            : [[`$(server) HTTP 状态码：${error.httpStatus}`] as string[]]),
          previous === undefined ? undefined : snapshotSection(previous),
          isAuth
            ? actions(
                ["重新设置 API Key", COMMAND_SET_API_KEY],
                ["查看详情", COMMAND_SHOW_DETAILS],
              )
            : DEFAULT_ACTIONS,
        ]),
        colorId,
        ...(backgroundColorId === undefined ? {} : { backgroundColorId }),
        command,
        accessibleLabel: label,
      };
    }
  }
}
