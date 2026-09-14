import * as vscode from "vscode";

import type { CurrencyPref } from "./deepseek/balance";
import { DEFAULT_BASE_URL } from "./deepseek/client";

export const CONFIG_SECTION = "deepseekBalance";

export interface AppConfig {
  baseUrl: string;
  /** 分钟；0 表示关闭自动刷新。 */
  refreshInterval: number;
  currency: CurrencyPref;
  lowBalanceThreshold: number;
  statusBarAlignment: "left" | "right";
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

  return {
    baseUrl,
    refreshInterval,
    currency,
    lowBalanceThreshold,
    statusBarAlignment,
  };
}

/** 只在 deepseekBalance 这一段变化时回调，避免无关设置触发重新拉取。 */
export function onConfigChanged(reporter: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) reporter();
  });
}
