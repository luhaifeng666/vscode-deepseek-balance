import * as vscode from "vscode";

import { CONFIG_SECTION } from "./config";
import type { RefreshController } from "./controller";
import type { BalanceSnapshot, UsageRange } from "./deepseek/types";
import { USAGE_RANGES, isUsageRange } from "./deepseek/usage";
import {
  COMMAND_CLEAR_API_KEY,
  COMMAND_CLEAR_USAGE_TOKEN,
  COMMAND_OPEN_SETTINGS,
  COMMAND_REFRESH,
  COMMAND_SET_API_KEY,
  COMMAND_SET_USAGE_TOKEN,
  COMMAND_SHOW_DETAILS,
  USAGE_RANGE_COMMANDS,
  USAGE_RANGE_LABELS,
  formatTime,
  type StatusState,
} from "./render";
import {
  clearApiKey,
  clearUsageToken,
  promptForApiKey,
  promptForUsageToken,
} from "./secrets";
import type { UsageController } from "./usageController";

const TOP_UP_URL = "https://platform.deepseek.com/top_up";

type DetailAction =
  | "refresh"
  | "setKey"
  | "topup"
  | "setUsageToken"
  | "clearUsageToken";

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
    // 用量只活在悬停里，悬停本身不提供任何「找得到这个功能」的线索。这里补一条
    // 不依赖悬停的触达路径——顺带也是 Token 过期后重新获取的入口。
    { label: "$(graph) 设置用量 Token", action: "setUsageToken" },
    { label: "$(trash) 清除用量 Token", action: "clearUsageToken" },
  );

  const picked = await vscode.window.showQuickPick<ActionItem>(items, {
    title: "DeepSeek 账户余额",
    placeHolder:
      `${snapshot.isAvailable ? "账户可用" : "账户不可用于 API 调用"}` +
      ` · 上次更新 ${formatTime(snapshot.fetchedAt)}` +
      // 接口地址从悬停挪到这里：排查「代理/网关配错」时要看的就是它，而日常
      // 悬停里那行只是噪音。
      ` · 接口 ${snapshot.endpoint}`,
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
    case "setUsageToken":
      await vscode.commands.executeCommand(COMMAND_SET_USAGE_TOKEN);
      break;
    case "clearUsageToken":
      await vscode.commands.executeCommand(COMMAND_CLEAR_USAGE_TOKEN);
      break;
    default:
      break;
  }
}

/**
 * 切换用量时间范围：写进**全局**设置，靠既有的配置变更链路重渲染。
 *
 * 为什么是 settings 而不是 globalState：这条链路已经存在（onConfigChanged →
 * controller.onConfigChanged → emit → onState），且冒烟里验过。为省一个 schema
 * 条目另造一条重渲染路径不划算，而且用户就再也没法在设置界面里看见/改这个值了。
 */
async function applyUsageRange(range: UsageRange): Promise<void> {
  const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await section.update("usageRange", range, vscode.ConfigurationTarget.Global);

  // 回读生效值。写的是 Global，而 Global 会被**工作区/工作区文件夹**层的同名
  // 设置盖住——表现就是「点了链接，数字纹丝不动」，且没有任何报错。既然这一层
  // 遮蔽是我们自己选的方案带来的，就得如实说清楚，不能静默失败。
  const inspect = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .inspect<string>("usageRange");

  const shadowing =
    inspect?.workspaceFolderValue !== undefined
      ? { scope: "工作区文件夹", value: inspect.workspaceFolderValue }
      : inspect?.workspaceValue !== undefined
        ? { scope: "工作区", value: inspect.workspaceValue }
        : undefined;

  if (shadowing === undefined || shadowing.value === range) return;

  const shown = isUsageRange(shadowing.value)
    ? USAGE_RANGE_LABELS[shadowing.value]
    : String(shadowing.value);
  void vscode.window.showInformationMessage(
    `用量时间范围已写入全局设置，但当前被${shadowing.scope}设置覆盖为「${shown}」。` +
      `要在这里生效，请修改${shadowing.scope}设置里的 deepseekBalance.usageRange。`,
  );
}

/** 三个范围命令用同一份实现注册，避免三份几乎相同的函数体各自漂移。 */
function registerUsageRangeCommand(range: UsageRange): vscode.Disposable {
  return vscode.commands.registerCommand(USAGE_RANGE_COMMANDS[range], () =>
    applyUsageRange(range),
  );
}

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: RefreshController,
  usage: UsageController,
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

  const usageRangeCommands = USAGE_RANGES.map((range) =>
    registerUsageRangeCommand(range),
  );

  return [
    // 用量出错时 tooltip 里的「重试」链接指向的就是这个命令（render.ts），所以这里
    // 必须连用量一起强制重查——否则那个链接点下去，用量数字纹丝不动。
    vscode.commands.registerCommand(COMMAND_REFRESH, async () => {
      await Promise.all([
        controller.refresh("manual"),
        usage.refresh("manual"),
      ]);
    }),

    vscode.commands.registerCommand(COMMAND_SHOW_DETAILS, () =>
      showDetails(controller),
    ),

    vscode.commands.registerCommand(COMMAND_SET_API_KEY, async () => {
      const stored = await promptForApiKey(context);
      if (stored === undefined) return;
      controller.onKeyChanged();
      // 用量轮询 gate 在 API Key 上，Key 一变就要重新判断放不放行。
      usage.onApiKeyChanged();
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
      usage.onApiKeyChanged();
      void vscode.window.showInformationMessage("已清除 DeepSeek API Key。");
    }),

    vscode.commands.registerCommand(COMMAND_SET_USAGE_TOKEN, async () => {
      const stored = await promptForUsageToken(context);
      if (stored === undefined) return;
      // ⚠️ 只能碰用量控制器。调 controller.onKeyChanged() 会把余额一起
      // invalidate 掉——换个用量 Token 不该让余额数字闪一下。
      usage.onTokenChanged();
      void vscode.window.showInformationMessage(
        "DeepSeek 用量 Token 已保存到系统钥匙串，正在获取用量…",
      );
    }),

    vscode.commands.registerCommand(COMMAND_CLEAR_USAGE_TOKEN, async () => {
      const confirmed = await vscode.window.showWarningMessage(
        "确定要清除已保存的 DeepSeek 用量 Token 吗？悬停提示将不再显示用量。",
        { modal: true },
        "清除",
      );
      if (confirmed !== "清除") return;

      await clearUsageToken(context);
      usage.onTokenChanged();
      void vscode.window.showInformationMessage("已清除 DeepSeek 用量 Token。");
    }),

    ...usageRangeCommands,

    vscode.commands.registerCommand(COMMAND_OPEN_SETTINGS, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", settingsQuery),
    ),
  ];
}
