import * as vscode from "vscode";

import type { CurrencyPref } from "./deepseek/balance";
import { DEFAULT_BASE_URL } from "./deepseek/client";
import type { UsageRange } from "./deepseek/types";
import { isUsageRange } from "./deepseek/usage";

export const CONFIG_SECTION = "deepseekBalance";

export interface AppConfig {
  baseUrl: string;
  /** 分钟；0 表示关闭自动刷新。用量轮询搭这条心跳的车，所以它也是 0 就都不轮询。 */
  refreshInterval: number;
  currency: CurrencyPref;
  lowBalanceThreshold: number;
  statusBarAlignment: "left" | "right";
  /** 用量时间范围。改动会经由既有的配置变更链路触发重渲染。 */
  usageRange: UsageRange;
}

export type WarningReporter = (message: string) => void;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 读取配置。这些值来自用户可编辑的 JSON，所以每一项都做防御性校验，
 * 非法值回退到默认而不是让扩展崩掉。
 */
export function readConfig(
  section?: vscode.WorkspaceConfiguration,
  warn: WarningReporter = () => {},
): AppConfig {
  const config = section ?? vscode.workspace.getConfiguration(CONFIG_SECTION);

  const rawBaseUrl = (config.get<string>("baseUrl") ?? DEFAULT_BASE_URL).trim();
  let baseUrl = DEFAULT_BASE_URL;
  if (/^https?:\/\//i.test(rawBaseUrl)) {
    // 去掉结尾斜杠，避免拼出 //user/balance。
    baseUrl = rawBaseUrl.replace(/\/+$/, "");
  } else {
    warn(
      `deepseekBalance.baseUrl 不是合法的 http(s) 地址（${rawBaseUrl || "空"}），已回退到 ${DEFAULT_BASE_URL}。`,
    );
  }

  const rawInterval = config.get<number>("refreshInterval") ?? 5;
  const refreshInterval = Number.isFinite(rawInterval)
    ? clamp(Math.floor(rawInterval), 0, 1440)
    : 5;

  const rawCurrency = config.get<string>("currency") ?? "AUTO";
  const currency: CurrencyPref =
    rawCurrency === "CNY" || rawCurrency === "USD" ? rawCurrency : "AUTO";

  const rawThreshold = config.get<number>("lowBalanceThreshold") ?? 10;
  const lowBalanceThreshold =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 0;

  const statusBarAlignment =
    config.get<string>("statusBarAlignment") === "left" ? "left" : "right";

  // 非法值静默回退到 today 就够，不必 warn：这个值的唯一写入方是我们自己的
  // range 命令（注册时已用 isUsageRange 校验过），手改配置写错的情况极少，而写错
  // 了也只是显示默认范围，没有需要用户立刻知道的事。
  const rawUsageRange = config.get<string>("usageRange");
  const usageRange: UsageRange = isUsageRange(rawUsageRange) ? rawUsageRange : "today";

  return {
    baseUrl,
    refreshInterval,
    currency,
    lowBalanceThreshold,
    statusBarAlignment,
    usageRange,
  };
}

/** 只在 deepseekBalance 这一段变化时回调，避免无关设置触发重新拉取。 */
export function onConfigChanged(reporter: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) reporter();
  });
}
