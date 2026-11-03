# bark-notify 🔔 — 任务事件推到 Bark

> 声音即优先级：完成 `glass` · 要你决策 `cicada` · 出错 `crow`+`critical`（可穿透静音/专注模式）。
> 你在浏览器前操作时自动降级为站内提示，手机不响；点推送可回 cockpit 或一键标记「已看到」。

## 为什么是 plugin 而不是裸 extension

| | 本插件（pwu plugin） | `~/.pi/extensions/*.ts` |
|---|---|---|
| 一条命令装到别的实例 | ✅ `pi-web-ui install` | ❌ 手动拷 |
| 密钥存放 | ✅ 设置项 `secret` 类型 → 进 secrets，不进 git | 只能 env/硬编码 |
| 点推送回环 | ✅ `route` → `/plugins-api/bark-notify/ack` | 无 HTTP 面 |
| 知道你是否在前台 | ✅ `onMessage` / `getActiveConversation` | 拿不到 |
| 档位开关 UI / 定时晨报 | ✅ `ui.register` + `schedule` | 无 |

## 安装

```bash
# A. 本机开发目录直接装（会自动备份同名旧版）
pi-web-ui install ./plugins/bark-notify --name bark-notify --force

# B. GitHub（monorepo 子目录 + 固定 tag，可复现）
pi-web-ui install yourname/pi-plugins/tree/main/bark-notify#v0.1.0

# C. catalog 批量（新机器一次装齐；单条失败不中断整批）
pi-web-ui install --catalog https://your.host/catalog.json          # 合并安装
pi-web-ui install --catalog https://your.host/catalog.json --force  # 更新全部

# 查看 / 卸载
pi-web-ui plugins
pi-web-ui uninstall bark-notify
```

装完**刷新浏览器**即生效（服务运行中也可发 `plugins_reload`）。

## 必配三项（都没有默认值，必须自己填）

| 项 | 说明 |
|---|---|
| Bark 服务器 | 例 `https://bark.example.com`，只 scheme+域名，**不带端口** |
| Bark 设备密钥 | `secret` 类型，存进 secrets，不进 git |
| **pi-web-ui 外网地址** | 反代域名，**不要带端口**（`https://cockpit.example.com` ✅，`https://cockpit.example.com:8787` ❌ 外网进不来） |

这三项是身份信息，插件**不给任何默认值**。不填就一条都不推，而且不静默：
站内通知 + 日志 + `GET /plugins-api/bark-notify/ping` 都会点名缺什么（`"configured": false, "missing": ["server", ...]`）。

**第四件事很多人漏：出站网络授权。** 宿主对 `net` 是 fail-closed，自架 Bark 域名没授权就全部拒发。

自架域名**不用改 manifest**：填完服务器点保存，插件会弹一次授权确认框，点放行即可（宿主会记住，之后不再问）。
手动漏放行或想撤销，去 设置 → 界面插件 → Bark 推送 → 已授权能力。

manifest 的 `netAllowlist` 只留公共默认值（`api.day.app` 等），个人域名不进仓库。
想要免弹框也可以走老路：加进 `netAllowlist` 再重装。

```bash
# 改 plugins/bark-notify/manifest.json → netAllowlist 加上 "bark.example.com"
pi-web-ui install ./plugins/bark-notify --name bark-notify --force   # 然后刷新浏览器
```

两条路都没走通也不会让你闷在鼓里：插件会当场点名「「bark.example.com」尚未获准出站」。

可选：推送档位（全推 / 只重要 / 全静音）、前台静音窗口、最短运行时长阈值、去重窗口、图标 URL（**默认空**）、晨报 cron。

## 设置页两个测试按钮

| 按钮 | 推什么 | 用途 |
|---|---|---|
| 📣 文字自检 | 走设置里的 icon（默认为空 → 用 App 图标），正文回显当前档位 / 图标 / 声音 / 前台静音窗口 | 确认通道通不通、现在是什么档位 |
| 🖼️ 带图测试 | 用旁边输入框里的 URL 当本条的 `icon`，只发这一条、**不写回设置** | 先试图标尺寸/域名能不能被 APNs 抓到，再决定要不要固定 |

图标输入框默认空；拉状态时会预填设置里的 `icon`，但你一手动改就不再覆盖。critical 级的附件图要求 ≥150×150 PNG —— 先用「带图测试」在手机上验一眼，确认尺寸与域名没问题，再往设置里固定。

## 事件 → 通知映射

| 宿主事件 | 标题 | 声音 / 级别 | 备注 |
|---|---|---|---|
| `run_end`（正常 stopReason） | `✅ <项目> · 任务完成` | `glass` / active | 短于「最短运行时长」不推 |
| `run_end`（`length`/`content_filter`） | `⚠️ <项目> · 提前收尾` | `bell` / timeSensitive | 提示要续一句 |
| `run_end`（`error`/`aborted`/`timeout`…） | `❌ <项目> · 中断` | `crow` / **critical** | 穿透静音 |
| `tool_approval_pending` | `🙋 等批准 · <项目>` | `cicada` / timeSensitive | 点推送 = `/ack` 记一笔 |
| `question_pending` | `🙋 需要你回答 · <项目>` | `cicada` / timeSensitive | 直达会话 |
| `run_start` | `⏳ <项目> · 开始` | `silence` / 归档 | 只记账不弹 |
| `turn_end` / `tool_delta` / … | — | 不推 | 防刷屏 |

## AI 与你的用法

- AI 侧工具 `bark_notify`：我在对话里可直接推一条（`level=critical` 穿透静音，`quiet=true` 只归档）。
- 斜杠命令：`/bark 部署完成`、`/bark 只记账 silent`。
- 脚本/其它机器共用配置推送（不必各自存 key）：
  ```bash
  curl -X POST https://<cockpit域名>/plugins-api/bark-notify/send \
    -H 'Content-Type: application/json' \
    -d '{"title":"✅ 备份完成","body":"NAS 3.2TB · 41s","level":"active"}'
  ```
- 其它端点：`GET /plugins-api/bark-notify/ping`（配置摘要，含是否已填 key）、`GET /status`（最近 20 条投递）、`GET /ack?t=<id>`（手机点推送后的极简确认页）。

## 三个踩过的坑（写死在实现里）

1. **必须 `POST /push` + snake_case `device_key`**。这类精简版 bark-server 的 GET 路径式 `/{key}/{title}/{body}` 也返 200，但内容透传不可靠。
2. **不要用 `jq '@uri'` 编码中文/emoji** —— jq 对非 ASCII 直接返回字面量 `null`，锁屏上就是「null」。本插件走 JSON body，中文/emoji/换行原生支持。
3. `permissions` 是**封闭白名单**，`net` 又是 **fail-closed**：
   合法族只有 `fs` `fs:read` `fs:write` `ui` `tools` `http` `chat` `net` `llm` `dom` `dom:anchor` `notify` `storage` `secrets` ——
   **没有 `schedule`**（定时无需声明，写了直接「未知能力」报错），用到的 `storage`/`notify`/`chat` 一个都不能漏。
   换你自己的 Bark 域名靠 `host.requestPermission` 动态授权（首次推送时弹框放行），否则出站全拒。
4. 权限漏声明时宿主往往只是**静默拒绝**，所以本插件在 activate 时逐项探测能力，结果挂在
   `GET /plugins-api/bark-notify/ping` 的 `capabilities` / `blocked` 字段和启动日志里（`能力 9/9 可用`）。

`level=critical` 还需 iOS 设置 → 通知 → Bark → 允许关键通知，否则会静默降级成普通横幅。

## 开发

```bash
node --check index.mjs client/entry.mjs            # 语法
node --test index.test.mjs                         # 单测（SDK 自带 createMockHost，无需起服务）
node /usr/local/lib/node_modules/pi-web-ui/plugin-sdk/import-check.mjs .   # 客户端越界/缺失自检
# manifest 权威校验（严格模式，0 error / 0 warning 才算过）
node --input-type=module -e '
const { validatePluginManifest } = await import("/usr/local/lib/node_modules/pi-web-ui/dist/server/plugin-manifest-validate.js");
const fs = await import("node:fs/promises");
const r = validatePluginManifest(JSON.parse(await fs.readFile("manifest.json", "utf8")), "bark-notify");
console.log("strict:", r.strict, "errors:", r.errors.length, "warnings:", r.warnings.length, JSON.stringify(r.permissions));'
pi-web-ui plugin upgrade-sdk bark-notify           # 升级宿主后刷新 SDK 拷贝
```

`client/entry.mjs` 里只能 `import "./sdk/index.mjs"`（宿主只把 `/plugins/<id>/client/*` 暴露给浏览器，越界 import 会让整个 bundle 静默不执行）。
