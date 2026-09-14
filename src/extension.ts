import * as vscode from "vscode";

import { onConfigChanged, readConfig } from "./config";
import { registerCommands } from "./commands";
import { RefreshController } from "./controller";
import { initLogger } from "./logging";
import { render } from "./render";
import { API_KEY_SECRET, getApiKey } from "./secrets";
import { StatusBarController } from "./statusBar";

export function activate(context: vscode.ExtensionContext): void {
  const log = initLogger();
  context.subscriptions.push(log);

  const statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  let config = readConfig(undefined, (message) => log.warn(message));

  const controller = new RefreshController({
    getApiKey: () => getApiKey(context),
    getConfig: () => config,
    onState: (state) =>
      statusBar.update(render(state, config), config.statusBarAlignment),
    debug: (message) => log.debug(message),
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  });
  context.subscriptions.push(controller);

  context.subscriptions.push(
    ...registerCommands(context, controller),

    onConfigChanged(() => {
      const previous = config;
      config = readConfig(undefined, (message) => log.warn(message));
      controller.onConfigChanged(previous, config);
    }),

    // 另一个窗口改了密钥时，本窗口也要跟上。
    context.secrets.onDidChange((event) => {
      if (event.key === API_KEY_SECRET) controller.onKeyChanged();
    }),

    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) controller.onFocus();
    }),
  );

  log.info(
    `DeepSeek 余额已激活（端点 ${config.baseUrl}，刷新间隔 ${config.refreshInterval} 分钟）。`,
  );

  controller.start();
}

/**
 * 保持同步空实现：context.subscriptions 已经覆盖了清理，
 * 在这里返回 Promise 只会让 VS Code 关机时去等一个可能还在途中的请求。
 */
export function deactivate(): void {}
