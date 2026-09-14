# DeepSeek 余额与用量

Show your DeepSeek account balance and usage in the VS Code status bar — auto-refreshing, multi-currency, with a low-balance warning.

在 VS Code 状态栏实时显示 DeepSeek 账户余额，悬停还能看到金额与 token 用量。

## 功能

- **状态栏常驻**：扫一眼就能看到余额，不用切窗口
- **悬停看用量**：金额、请求次数、输入/输出 token（含缓存命中/未命中），不用再开控制台
- **可切时间范围**：今日 / 近 7 天 / 本月，在悬停里点一下就换
- **自动刷新**：启动时查一次，之后按可配置间隔轮询，也可随时手动刷新
- **多币种**：接口返回多种币种时全部列出，状态栏只显示你选中的那个
- **低余额提醒**：低于阈值时状态栏转为警告色
- **密钥安全**：两枚凭据都只存在系统钥匙串里，不写入 `settings.json`，也不会被 Settings Sync 同步到云端

## 效果

状态栏：

```
💳 CNY 34.53
```

悬停提示：

```
DeepSeek 账户余额

CNY 34.53（赠送 0.00 / 充值 34.53）

✓ 账户状态：可用
🕘 上次更新：2026-09-14 15:32:10
🖥 接口地址：https://api.deepseek.com/user/balance

用量 · 今日    近 7 天 · 本月

CNY 1.75 · 请求 42 次
Token 输入 11,000（缓存命中 8,000 / 未命中 2,000） · 输出 2,345
🕘 用量更新：2026-09-14 15:32:11

立即刷新 · 查看详情 · 设置
```

各种状态会如实反映在状态栏上：

| 情况 | 状态栏 |
| --- | --- |
| 尚未配置 Key | `🔑 DeepSeek` |
| 正常 | `💳 CNY 34.53` |
| 余额低于阈值 | `⚠ CNY 3.20`（黄色背景） |
| 数据过期 | `⚠ CNY 34.53`（黄色文字） |
| API Key 无效 | `⛔ DeepSeek 密钥无效`（红色背景） |
| 连接失败 | `⚠ DeepSeek 连接失败` |
| 余额不可用于 API 调用 | `🚫 CNY 34.53`（黄色背景） |

**用量出任何问题都不影响余额。** 用量 Token 过期时悬停里只多一行「userToken 已过期 · 重新获取」，状态栏的余额数字照旧：

| 用量侧情况 | 悬停里的用量段 |
| --- | --- |
| 未配置 Token | 未配置 userToken · 去配置 |
| Token 过期（含被重定向到登录页） | userToken 已过期 · 重新获取 |
| 接口返回异常（HTTP n） | 接口返回异常（HTTP n）· 重试 |
| 结构不符预期 | 接口返回异常 · 重试 |
| 连接失败 / 超时 | 连接失败 / 请求超时 · 重试 |

## 安装

从 VSIX 安装：

```sh
code --install-extension vscode-deepseek-balance-0.2.0.vsix
```

## 使用

1. `Cmd/Ctrl+Shift+P` 打开命令面板
2. 运行 **DeepSeek: 设置 API Key**
3. 粘贴你的 DeepSeek API Key（可从 <https://platform.deepseek.com/api_keys> 获取）

状态栏随即出现余额。点击状态栏可以查看详情、立即刷新或前往充值。

### 再看用量（可选，需要第二枚凭据）

DeepSeek **没有公开的用量接口**。用量与消费数据在控制台的未公开接口上，需要另一枚凭据——浏览器里的**控制台会话 token**（`userToken`），它的权限比 API Key 宽，而且**会过期**。

1. 登录 <https://platform.deepseek.com>，按 F12 打开开发者工具
2. 在 Console 里执行下面这行。它只把值复制到剪贴板，**不会在屏幕上打印任何东西**：

   ```js
   copy(JSON.parse(localStorage.getItem('userToken')).value)
   ```

3. 回到 VS Code，运行 **DeepSeek: 设置用量 Token**，粘贴

悬停里就会出现用量段。Token 过期后重复第 1–3 步即可（悬停里会明确提示「已过期」）。

> 只想要余额的话**不用配这一项**，本扩展也不会为此向任何地址多发一个请求。

## 设置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekBalance.refreshInterval` | `5` | 自动刷新间隔（分钟）。`0` 关闭自动刷新，只保留手动（用量也一并停止后台轮询） |
| `deepseekBalance.baseUrl` | `https://api.deepseek.com` | 接口基础地址，走代理或自建网关时改这里 |
| `deepseekBalance.currency` | `AUTO` | 状态栏优先显示的币种：`AUTO` / `CNY` / `USD` |
| `deepseekBalance.lowBalanceThreshold` | `10` | 低于该值时告警，`0` 关闭 |
| `deepseekBalance.statusBarAlignment` | `right` | 显示在状态栏左侧还是右侧 |
| `deepseekBalance.usageRange` | `today` | 悬停里用量的时间范围：`today` / `week` / `month` |

### 命令

| 命令 | 说明 |
| --- | --- |
| `DeepSeek: 刷新余额` | 立即查询一次（余额与用量一起） |
| `DeepSeek: 查看余额详情` | 列出各币种明细，并提供刷新 / 重设 Key / 充值 / 用量 Token 入口 |
| `DeepSeek: 设置 API Key` | 设置或替换 API Key |
| `DeepSeek: 清除 API Key` | 从钥匙串中删除已保存的 Key |
| `DeepSeek: 设置用量 Token` | 设置或替换控制台会话 token |
| `DeepSeek: 清除用量 Token` | 从钥匙串中删除用量 Token |
| `DeepSeek: 用量范围：今日 / 近 7 天 / 本月` | 切换悬停里用量的时间范围 |
| `DeepSeek: 打开余额设置` | 直接跳转到本扩展的设置页 |

## 常见问题

**走代理没生效？**

VS Code 的 `http.proxy` 设置**不会**作用于本扩展的请求——扩展宿主用的是 Node 的原生 `fetch`，它不读 VS Code 的代理配置。请改 `deepseekBalance.baseUrl`，指向你的代理或网关地址。当前生效的地址可以在悬停提示的最后一行看到。

**提示「API Key 无效」？**

多半是粘贴时带上了换行或空格，或者 Key 已被撤销。重新运行一次「设置 API Key」即可，本扩展在保存前会自动去掉首尾空白。

**状态栏显示黄色但数字是旧的？**

说明最近一次刷新失败了（网络问题或接口异常），此时会保留最后一次成功的值并在提示里标注「数据可能已过期」，而不是把数字清空。

**低余额阈值是怎么比较的？**

阈值以**状态栏当前显示的币种**为准、不做汇率换算。账户同时有人民币和美元时，请按你实际显示的那个币种来设阈值。

**「今日」和「近 7 天 / 本月」的口径一样吗？**

不一样，这是接口规则逼出来的，不是随手定的：

- **今日**用**本地日界**（你所在时区的 0:00 起），是最常看的那个数，它是准的。
- **近 7 天 / 本月**按 **UTC 日**切分，与本地日界最多差 8 小时。悬停里会把窗口明确写成 `窗口 09-01 → 10-01（UTC 日界，与本地日界可能相差数小时）`，不会含糊地只说「本月」。

原因是接口只接受 **UTC 零点对齐**的长窗口——本地对齐且超过 24 小时的窗口会被直接拒绝（HTTP 200 + `biz_code=1`）。

**用量是从哪来的？**

控制台的未公开接口，不是官方 API。因此：

- 它可能在任何时候改结构。真改了的表现是悬停里显示「接口返回异常」，**余额不受影响**。
- 字段含义按控制台用量页对齐过：`REQUEST` 是**请求次数**、不是 token 数。
- `model` 可能是复合名（如 `deepseek-chat & deepseek-reasoner`），所以本扩展不按模型拆分展示。

**点了范围链接却没反应？**

本扩展把范围写进**全局**设置。如果你在工作区（或工作区文件夹）层也设过 `deepseekBalance.usageRange`，它会盖住全局值——这时扩展会弹一条提示说明被哪一层覆盖了，不会静默失败。

## 隐私

- **无遥测、无数据上报、无分析埋点**
- 两枚凭据（API Key 与控制台用量 Token）都只保存在 VS Code 的 `SecretStorage`（macOS 上即系统钥匙串），不会写入 `settings.json`
- 由于不在设置里，两枚凭据都**不会**被 Settings Sync 同步——换机器需要重新设置一次
- **一个请求都不发的两种情况**：没配 API Key 时，或 `refreshInterval` 为 `0` 且你没有手动触发时。没有 API Key 就**完全不查用量**——那时悬停里根本没有用量段，没有理由去打第三方主机
- 配了 API Key 后，扩展只会向两处发起请求：你配置的 `baseUrl`（余额），以及 `https://platform.deepseek.com`（用量，控制台的未公开接口，未使用官方 API）。没有别的地址
- 用量 Token 只发给 `platform.deepseek.com`。**它不可能被配置改道**：控制端点的地址不是设置项，只从环境变量读，且只接受 `localhost` / `127.0.0.1` / `[::1]`（开发与测试用），填别的会被强制换回官方地址
- 两枚凭据都不会被写进日志、错误提示或悬停信息

## 开发

```sh
pnpm install
pnpm run check      # 类型检查
pnpm test           # 单元测试 + 真实 HTTP 集成测试
pnpm run smoke      # 冒烟测试：加载 dist/ 跑一遍 activate()
pnpm run smoke:vsix # 同上，但加载打包好的 .vsix（需先 package）
pnpm run watch      # 开发时增量构建，然后在 VS Code 里按 F5
pnpm run package    # 打包成 .vsix
```

`pnpm test` 测的是源码逻辑；`pnpm run smoke` 测的是**装进 VS Code 之后会怎样** —— 它在纯 Node 下用手写的 `vscode` 桩加载真正的产物，跑一遍 `activate()`，让扩展对着本地 mock 接口完成「激活 → 拉取 → 渲染 → 执行命令 → 释放」。`smoke:vsix` 更进一步，从 `.vsix` 里解出 `extension/` 再加载，因此还顺带核对打包内容（`.vscodeignore` 有没有漏排开发文件、`main` 指向的文件在不在包里）—— 这类问题单元测试看不见。CI 上发布前跑的就是它。

调试那些对着真实接口无法按需复现的分支（余额不可用、空余额、非 JSON、401/403、超时、**会话过期、结构漂移**……）时，用本地假接口：

```sh
node scripts/mock-balance.mjs                        # 启动在 127.0.0.1:8787
curl http://127.0.0.1:8787/mode/low                  # 切余额模式
curl http://127.0.0.1:8787/usage-mode/expired        # 切用量模式
```

余额与用量是**两把独立的旋钮**，这是刻意的：用量要验的恰恰是「余额正常 + 用量过期」这种**隔离**场景，共用一个模式就造不出来。用完量的那几个模式时，除了 `deepseekBalance.baseUrl`，还要把控制端点地址指过去：

```sh
DEEPSEEK_USAGE_BASE_URL=http://127.0.0.1:8787 code --extensionDevelopmentPath=$(pwd)
```

（它不是配置项，只从环境变量读，且只接受回环地址——理由见上面的「隐私」。）

服务端每次请求都会打一行日志，带上凭据的 8 位 SHA-256 指纹。余额与用量两条链路的指纹应当**不同**，这是「两枚凭据没有串用」最直观的验证：

```
[mock] GET /user/balance (mode=ok) auth=b2a8ade0
[mock] GET /api/v0/usage/by_api_key/cost?start=…&end=…&tz=0 (usage-mode=ok) auth=b6784d01
```

可用模式见脚本开头的 `MODES` 与 `USAGE_MODES`。

图标可用 `node scripts/make-icon.mjs` 重新生成。

## License

[MIT](LICENSE)
