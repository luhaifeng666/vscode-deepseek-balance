import * as vscode from "vscode";

import type { RefreshController } from "./controller";
import type { BalanceSnapshot } from "./deepseek/types";
import {
  COMMAND_CLEAR_API_KEY,
  COMMAND_OPEN_SETTINGS,
  COMMAND_REFRESH,
  COMMAND_SET_API_KEY,
  COMMAND_SHOW_DETAILS,
  formatTime,
  type StatusState,
} from "./render";
import { clearApiKey, promptForApiKey } from "./secrets";

const TOP_UP_URL = "https://platform.deepseek.com/top_up";

type DetailAction = "refresh" | "setKey" | "topup";

interface ActionItem extends vscode.QuickPickItem {
  action?: DetailAction;
}

/** 取出当前可展示的快照：正常态用它自己，其余态用上一次的已知良好值。 */
function currentSnapshot(state: StatusState): BalanceSnapshot | undefined {
  switch (state.kind) {
    case "ok":
      return state.snapshot;
    case "loading":
    case "error":
      return state.previous;
    case "no-key":
      return undefined;
  }
}

async function showDetails(controller: RefreshController): Promise<void> {
  const snapshot = currentSnapshot(controller.getState());

  if (snapshot === undefined) {
    const picked = await vscode.window.showInformationMessage(
      "DeepSeek 余额：暂时没有数据，请先刷新。",
      "刷新余额",
    );
    if (picked !== undefined) {
      await vscode.commands.executeCommand(COMMAND_REFRESH);
    }
    return;
  }

  const items: ActionItem[] =
    snapshot.infos.length === 0
      ? [{ label: "（无余额信息）" }]
      : snapshot.infos.map((info) => ({
          label: `$(credit-card) ${info.currency} ${info.total_balance}`,
          description: `赠送 ${info.granted_balance ?? "0"} / 充值 ${info.topped_up_balance ?? "0"}`,
        }));

  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(refresh) 立即刷新", action: "refresh" },
    { label: "$(key) 重新设置 API Key", action: "setKey" },
    { label: "$(credit-card) 前往充值", action: "topup" },
  );

  const picked = await vscode.window.showQuickPick<ActionItem>(items, {
    title: "DeepSeek 账户余额",
    placeHolder:
      `${snapshot.isAvailable ? "账户可用" : "账户不可用于 API 调用"}` +
      ` · 上次更新 ${formatTime(snapshot.fetchedAt)}`,
  });

  switch (picked?.action) {
    case "refresh":
      await vscode.commands.executeCommand(COMMAND_REFRESH);
      break;
    case "setKey":
      await vscode.commands.executeCommand(COMMAND_SET_API_KEY);
      break;
    case "topup":
      await vscode.env.openExternal(vscode.Uri.parse(TOP_UP_URL));
      break;
    default:
      break;
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: RefreshController,
): vscode.Disposable[] {
  // 从清单里读，避免改了 publisher/name 之后设置页链接失效。
  const { publisher, name } = context.extension.packageJSON as {
    publisher?: string;
    name?: string;
  };
  const settingsQuery =
    publisher !== undefined && name !== undefined
      ? `@ext:${publisher}.${name}`
      : "deepseekBalance";

  return [
    vscode.commands.registerCommand(COMMAND_REFRESH, () =>
      controller.refresh("manual"),
    ),

    vscode.commands.registerCommand(COMMAND_SHOW_DETAILS, () =>
      showDetails(controller),
    ),

    vscode.commands.registerCommand(COMMAND_SET_API_KEY, async () => {
      const stored = await promptForApiKey(context);
      if (stored === undefined) return;
      controller.onKeyChanged();
      void vscode.window.showInformationMessage(
        "DeepSeek API Key 已保存到系统钥匙串，正在刷新余额…",
      );
    }),

    vscode.commands.registerCommand(COMMAND_CLEAR_API_KEY, async () => {
      const confirmed = await vscode.window.showWarningMessage(
        "确定要清除已保存的 DeepSeek API Key 吗？",
        { modal: true },
        "清除",
      );
      if (confirmed !== "清除") return;

      await clearApiKey(context);
      controller.onKeyChanged();
      void vscode.window.showInformationMessage("已清除 DeepSeek API Key。");
    }),

    vscode.commands.registerCommand(COMMAND_OPEN_SETTINGS, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", settingsQuery),
    ),
  ];
}
