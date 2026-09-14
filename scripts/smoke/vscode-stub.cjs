// 手写的 `vscode` 模块桩，让打包产物能在纯 Node 下跑一遍 activate()。
//
// 故意**不用 Proxy 兜底**：兜底会让拼错的 API 名静默通过，而这个桩存在的
// 全部意义就是抓住拼错的 API 名和空引用。缺什么就补什么，补的时候顺手确认
// 真实 API 的形状（`vscode.d.ts` 里那份）。
//
// 它不追求覆盖整个 API 面，只覆盖这个扩展真正碰到的那部分。扩展一旦用了新
// API，这里就会以 "xxx is not a function" 失败 —— 那是预期行为，去补上即可。
const { EventEmitter } = require("node:events");

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) this._fn();
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
    this.supportThemeIcons = false;
    this.isTrusted = false;
  }
  appendText(v) {
    this.value += v;
    return this;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

const StatusBarAlignment = { Left: 1, Right: 2 };
const QuickPickItemKind = { Separator: -1, Default: 0 };

/** 扩展在激活期创建出来的东西，供测试断言。 */
const created = {
  statusBarItems: [],
  outputChannels: [],
  commands: [],
  quickPicks: [],
  messages: [],
  inputBox: undefined,
};

function createStatusBarItem(alignment, priority) {
  const item = {
    alignment,
    priority,
    text: "",
    tooltip: undefined,
    command: undefined,
    color: undefined,
    backgroundColor: undefined,
    name: undefined,
    accessibilityInformation: undefined,
    shown: false,
    disposed: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {
      this.disposed = true;
    },
  };
  created.statusBarItems.push(item);
  return item;
}

const configStore = {};
const configListeners = new EventEmitter();

const workspace = {
  getConfiguration(section) {
    const prefix = section ? `${section}.` : "";
    return {
      get(key, fallback) {
        const full = `${prefix}${key}`;
        return full in configStore ? configStore[full] : fallback;
      },
    };
  },
  onDidChangeConfiguration(listener) {
    configListeners.on("change", listener);
    return new Disposable(() => configListeners.off("change", listener));
  },
};

const window = {
  createStatusBarItem,
  createOutputChannel(name) {
    const channel = {
      name,
      lines: [],
      debug(m) {
        this.lines.push(["debug", m]);
      },
      info(m) {
        this.lines.push(["info", m]);
      },
      warn(m) {
        this.lines.push(["warn", m]);
      },
      error(m) {
        this.lines.push(["error", m]);
      },
      trace(m) {
        this.lines.push(["trace", m]);
      },
      append() {},
      appendLine() {},
      replace() {},
      clear() {},
      show() {},
      hide() {},
      dispose() {},
    };
    created.outputChannels.push(channel);
    return channel;
  },
  onDidChangeWindowState(listener) {
    window._windowState = listener;
    return new Disposable(() => {});
  },
  // 弹出即返回 undefined，等于「用户按了 Esc」。要模拟用户真输入，
  // 在调用前覆写这一个函数。
  showInputBox: async (options) => {
    created.inputBox = options;
    return undefined;
  },
  showQuickPick: async (items, options) => {
    created.quickPicks.push({ items, options });
    return undefined;
  },
  showInformationMessage: async (message, ...rest) => {
    created.messages.push(["info", message, rest]);
    return undefined;
  },
  // 确认类对话框：默认点第一个按钮，模拟用户确认。
  showWarningMessage: async (message, ...rest) => {
    created.messages.push(["warn", message, rest]);
    const buttons = rest.filter((r) => typeof r === "string");
    return buttons.length ? buttons[0] : undefined;
  },
  showErrorMessage: async (message, ...rest) => {
    created.messages.push(["error", message, rest]);
    return undefined;
  },
};

const commands = {
  registered: new Map(),
  registerCommand(id, handler) {
    commands.registered.set(id, handler);
    created.commands.push(id);
    return new Disposable(() => commands.registered.delete(id));
  },
  executeCommand: async () => undefined,
};

const Uri = {
  parse(value) {
    return { toString: () => value, scheme: String(value).split(":")[0] };
  },
};

const env = { openExternal: async () => true };

module.exports = {
  Disposable,
  MarkdownString,
  ThemeColor,
  StatusBarAlignment,
  QuickPickItemKind,
  workspace,
  window,
  commands,
  Uri,
  env,
  __created: created,
  __configStore: configStore,
  __configListeners: configListeners,
};
