import * as vscode from "vscode";

import { onConfigChanged, readConfig } from "./config";
import { registerCommands } from "./commands";
import { RefreshController } from "./controller";
import { initLogger } from "./logging";
import { render } from "./render";
import { API_KEY_SECRET, USAGE_TOKEN_SECRET, getApiKey, getUsageToken } from "./secrets";
import { StatusBarController } from "./statusBar";
import { resolveUsageBaseUrl } from "./deepseek/usage";
import { UsageController } from "./usageController";

export function activate(context: vscode.ExtensionContext): void {
  const log = initLogger();
  context.subscriptions.push(log);

  const statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  let config = readConfig(undefined, (message) => log.warn(message));

  /**
   * **唯一**的写状态栏入口。
   *
   * 现在有两个生产者（余额、用量）要更新同一个 StatusBarItem，而
   * StatusBarController.update() 是全量覆盖、没有合并语义。两边各自调一次
   * update、各自带上自己那份对方状态的话，就会互相盖——典型症状是「用量更新落在
   * 余额刷新中途，渲染出一个过期的余额数字」。
   *
   * 所以两边都走这里，每次都用**当下**的活值重渲染。下面两个控制器里的
   * `() => renderNow()` 是故意的向前引用：renderNow 是函数声明（会提升），
   * 而这两个回调只可能在激活流程走完之后才被调用。
   */
  function renderNow(): void {
    statusBar.update(
      render(controller.getState(), config, usage.getView()),
      config.statusBarAlignment,
    );
  }

  const controller = new RefreshController({
    getApiKey: () => getApiKey(context),
    getConfig: () => config,
    onState: () => {
      renderNow();
      // 余额的每次 emit 都是一次心跳（含自重排的 timer 那一发）。用量不起自己的
      // 定时器，就是搭这条车；是否真发请求由 UsageController 内部的陈旧门槛决定。
      void usage.refresh("timer");
    },
    debug: (message) => log.debug(message),
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  });
  context.subscriptions.push(controller);

  const usage = new UsageController({
    getUsageToken: () => getUsageToken(context),
    // 轮询 gate 在「已配 API Key」上：no-key 态下 tooltip 根本不渲染用量段，
    // 那时还去轮询就是「用户看不到收益却打了第三方主机」。
    hasApiKey: async () => (await getApiKey(context)) !== undefined,
    getConfig: () => config,
    // 只读 process.env 里的本地回环测试钩子，见 resolveUsageBaseUrl：
    // 它结构上只可能返回 127.0.0.1/localhost/[::1] 或官方地址。
    baseUrl: resolveUsageBaseUrl(process.env.DEEPSEEK_USAGE_BASE_URL),
    onView: () => renderNow(),
    debug: (message) => log.debug(message),
    warn: (message) => log.warn(message),
  });
  context.subscriptions.push(usage);

  context.subscriptions.push(
    ...registerCommands(context, controller, usage),

    onConfigChanged(() => {
      const previous = config;
      config = readConfig(undefined, (message) => log.warn(message));
      controller.onConfigChanged(previous, config);
      // 时间范围就在这份配置里；范围变了控制器会强制重查（见 UsageController.refresh）。
      void usage.refresh("config");
    }),

    // 另一个窗口改了密钥时，本窗口也要跟上。
    context.secrets.onDidChange((event) => {
      if (event.key === API_KEY_SECRET) {
        controller.onKeyChanged();
        // gate 挂在 API Key 上：Key 从无到有意味着用量**第一次**可以查了。
        usage.onApiKeyChanged();
      } else if (event.key === USAGE_TOKEN_SECRET) {
        // ⚠️ 用量 Token 只能走用量这条路。调 controller.onKeyChanged() 会把余额
        // 一起 invalidate，换个用量 Token 不该让余额数字闪一下。
        usage.onTokenChanged();
      }
    }),

    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      controller.onFocus();
      // 用量搭余额心跳的车：它不起自己的定时器，心跳/聚焦/配置变更全靠这几条扇出。
      usage.onFocus();
    }),
  );

  log.info(
    `DeepSeek 余额已激活（端点 ${config.baseUrl}，刷新间隔 ${config.refreshInterval} 分钟）。`,
  );

  controller.start();
  // 用量也是无条件启动一次：refreshInterval: 0（用户关掉自动刷新）时陈旧门槛
  // 恒为「不陈旧」，只能靠 startup 这一发把首次数据取回来。
  void usage.refresh("startup");
}

/**
 * 保持同步空实现：context.subscriptions 已经覆盖了清理，
 * 在这里返回 Promise 只会让 VS Code 关机时去等一个可能还在途中的请求。
 */
export function deactivate(): void {}
