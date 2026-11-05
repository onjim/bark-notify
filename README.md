# bark-notify 🔔 — 任务事件推到 Bark

> 声音区分类型：完成 `glass` · 出错 `crow`；按触发条件独立选择普通、时效性或关键通知（静音穿透）。
> 所有类别默认普通提示，只有主动选择关键通知才会请求静音穿透。
> 点推送可回 cockpit。

## 为什么是 plugin 而不是裸 extension

| | 本插件（pwu plugin） | `~/.pi/extensions/*.ts` |
|---|---|---|
| 一条命令装到别的实例 | ✅ `pi-web-ui install` | ❌ 手动拷 |
| 密钥存放 | ✅ 设置项 `secret` 类型 → 进 secrets，不进 git | 只能 env/硬编码 |
| 推送档位 | ✅ 插件设置 | 无 |

## 安装

```bash
# A. 本机开发目录直接装（会自动备份同名旧版）
pi-web-ui install ./plugins/bark-notify --name bark-notify --force

# B. GitHub（monorepo 子目录 + 固定 tag，可复现）
pi-web-ui install yourname/pi-plugins/tree/main/bark-notify#v0.1.1

# C. catalog 批量（新机器一次装齐；单条失败不中断整批）
pi-web-ui install --catalog https://your.host/catalog.json          # 合并安装
pi-web-ui install --catalog https://your.host/catalog.json --force  # 更新全部

# 查看 / 卸载
pi-web-ui plugins
pi-web-ui uninstall bark-notify
```

装完**刷新浏览器**即生效（服务运行中也可发 `plugins_reload`）。

## 插件配置

| 项 | 说明 |
|---|---|
| Bark 服务器 | 例 `https://bark.example.com`，只 scheme+域名，**不带端口** |
| Bark 设备密钥 | `secret` 类型，存进 secrets，不进 git |
| pi-web-ui 外网地址（可选） | 填写后可从通知跳转回 pi-web-ui；留空仍可接收通知，但没有跳转链接。例 `https://cockpit.example.com` |
| 锁屏信息量 | `精简`（状态 + 时长两行）/ `标准`（默认：末句摘要、分支、测试结论、文件数、下一步）/ `详尽`（文件清单全列 + 会话与轮次）。全本地解析（会话快照 + `git status`），**不吃 token** |
| 模型提问提醒 | 默认开。模型调 `ask_user_question` 时整个回合阻塞在你这边 → `⏳ <项目> · 等你回答`，按「等待回答 · 通知级别」发送且不受档位与时长限制；回答后的等待时长写进本轮完成通知的「中途等你 X」一行 |

Bark 服务器和设备密钥为必填项，插件**不给默认值**。缺少任一项时不会推送：
站内通知 + 日志 + `GET /plugins-api/bark-notify/ping` 都会点名缺什么（`"configured": false, "missing": ["server", ...]`）。

**出站网络授权：** 宿主对 `net` 是 fail-closed，自架 Bark 域名没授权就全部拒发。

自架域名**不用改 manifest**：保存新服务器地址后插件会尝试申请授权，在确认框中放行即可。若授权未完成，插件会给出站内提醒。
手动漏放行或想撤销，去 设置 → 界面插件 → Bark 推送 → 已授权能力。

授权未完成时，可在浏览器连接着 pi-web-ui 的情况下主动重试并发送一条测试通知：

```bash
curl -X POST http://localhost:8787/plugins-api/bark-notify/test -H 'Content-Type: application/json' -d '{}'
```

该接口使用宿主的访问控制；若启用了 `PI_WEB_TOKEN`，请求还需按宿主配置携带凭据。它会真实发送通知，响应不包含设备密钥。

manifest 的 `netAllowlist` 只留公共默认值（`api.day.app` 等），个人域名不进仓库。
想要免弹框也可以走老路：加进 `netAllowlist` 再重装。

```bash
# 改 plugins/bark-notify/manifest.json → netAllowlist 加上 "bark.example.com"
pi-web-ui install ./plugins/bark-notify --name bark-notify --force   # 然后刷新浏览器
```

两条路都没走通也不会让你闷在鼓里：插件会当场点名「「bark.example.com」尚未获准出站」。

可选：推送档位（全部：完成+出错 / 只推出错（默认））、完成通知最短运行时长（默认 5 分钟）、去重窗口、图标 URL（**默认空**）。档位只管自动事件：出错任何档都推且不受时长限制；「完成」仅「全部」档推，另受最短运行时长过滤（设 0 = 不限）。上线回执、自检 /test、外部 /send 与 bark_notify 工具推送属强制通道，不受档位限制。

## 触发分类与通知级别

在 **设置 → 界面插件 → Bark 推送** 中，下列五类各有独立的通知级别下拉框。新安装与未配置的旧设置均默认为 `active`，不会自动升级为关键通知；保存后对后续通知生效，无需重启。

| 分类 / 设置键 | 已知触发条件 | 标题 / 声音 | 发送限制 |
|---|---|---|---|
| 正常完成 `completionLevel` | `run_end` 正常结束（如 `end_turn`、`stop`；现有逻辑将未识别的非异常原因也归此类） | `✅ 任务完成` / `glass` | 仅「全部」档；另受最短运行时长限制 |
| 异常或中断 `interruptionLevel` | `run_end`：`error`、`aborted`、`abort`、`cancelled`、`canceled`、`timeout`、`refusal`；以及 `run_error` / `agent_error` | `❌ 中断 / 报错` / `crow` | 任何档位，不受时长限制；主动取消也归此类 |
| 提前收尾 `truncationLevel` | `run_end`：`length`、`max_tokens`、`context_length`、`content_filter` | `⚠️ 提前收尾` / `bell` | 任何档位，不受时长限制 |
| 等待回答 `questionLevel` | `onToolEvent`：`ask_user_question` / `ask_user` 的 `start` | `⏳ 等你回答` / `campaign` | 须开启提问提醒；不受档位与时长限制；同一提问不重推，`end` 仅记等待时长 |
| 服务提示 `serviceLevel` | 插件上线回执（含能力受限提示）、手动 `POST /test` | `🔌 已加载` / `Bark 推送测试` | 不受档位与时长限制；上线回执仍有 10 分钟节流 |

每类可选：

| 级别 | 含义 |
|---|---|
| 普通 `active`（默认） | 普通通知，遵循设备静音/专注设置 |
| 时效性 `timeSensitive` | 时效性通知，能否通过专注模式取决于系统授权与设置；不等于静音穿透 |
| 关键 `critical` | 请求关键通知，可穿透静音/专注模式；须 Bark 支持，并在 iOS 设置 → 通知 → Bark 中开启关键通知权限，实际行为由系统决定 |

**推送档位管「发不发」，通知级别管「怎么提醒」**。例如把完成设为关键通知，也不会绕过「只推出错」或最短运行时长过滤。想只在需要回答时穿透，可设「等待回答 = 关键」，其余保持普通。

`run_start` 只记开始时间；`turn_end`、工具增量、普通工具报错不单独推送（任务级错误按上表处理）。普通文本里的提问、`question_pending`、审批待确认不作为可靠触发信号，不发送此类自动通知。

## AI 与你的用法

- AI 侧工具 `bark_notify` 和外部 `/send` 可逐条指定 `level: "active" | "timeSensitive" | "critical"`，不继承五类自动通知设置；省略或非法值回退 `active`。`quiet=true`（或 `/send` 的 `archived=true`）优先：使用静音声音与普通级别，避免关键通知穿透。
- 脚本/其它机器共用配置推送（不必各自存 key）；可选 `session` 附会话 UUID，点推送直达该会话：
  ```bash
  curl -X POST https://<cockpit域名>/plugins-api/bark-notify/send \
    -H 'Content-Type: application/json' \
    -d '{"title":"✅ 备份完成","body":"NAS 3.2TB · 41s","level":"active","session":"01a18aa8-f143-7209-b1bb-2e84cfe8119e"}'
  ```
- 任务事件（完成/中断）与「等你回答」提醒的跳转链接自动带 `#s=<会话 UUID>`（取宿主事件里的 sessionId；`onToolEvent` 不带，则用同一会话 run 事件缓存的值），填了外网地址即生效；点推送直接落到干完活（或卡在等你）的那条会话。
- 其它端点：`GET /plugins-api/bark-notify/ping`（配置摘要，含是否已填 key、五类生效的 `levels`）、`GET /status`（最近 20 条投递，含 `category` 与实际 `level`，可核对分类是否正确）。

## 三个踩过的坑（写死在实现里）

1. **必须 `POST /push` + snake_case `device_key`**。这类精简版 bark-server 的 GET 路径式 `/{key}/{title}/{body}` 也返 200，但内容透传不可靠。
2. **不要用 `jq '@uri'` 编码中文/emoji** —— jq 对非 ASCII 直接返回字面量 `null`，锁屏上就是「null」。本插件走 JSON body，中文/emoji/换行原生支持。
3. `permissions` 是**封闭白名单**，`net` 又是 **fail-closed**：
   合法族只有 `fs` `fs:read` `fs:write` `ui` `tools` `http` `chat` `net` `llm` `dom` `dom:anchor` `notify` `storage` `secrets` ——
   **没有 `schedule`**（定时无需声明，写了直接「未知能力」报错），用到的 `storage`/`notify`/`chat` 一个都不能漏。
   换你自己的 Bark 域名靠 `host.requestPermission` 动态授权（首次推送时弹框放行），否则出站全拒。
4. 权限漏声明时宿主往往只是**静默拒绝**（个别接口直接抛错），所以本插件在 activate 时逐项探测能力，结果挂在
   `GET /plugins-api/bark-notify/ping` 的 `capabilities` / `blocked` 字段和启动日志里（`能力 10/10 可用`）。
   探出来最疼的一个：`host.scm.status()`（锁屏那行 `main*` 的来源）要 `fs`/`fs:read`，**未声明就抛**
   （`plugins.js:3996-4003`），本插件 catch 掉只会少一行——所以 `permissions` 里的 `fs:read` 不能删，
   测试 `manifest 声明了 fs/fs:read` 盯着它；`scm` 也在探测项里，被拒时 /ping 会点名。

5. **「模型给的选项」在插件侧看不到**：助手文本里的 `[[action:suggest:...]]` marker 会在序列化时被
   `stripMarkers` 整段刷空（`serialize.js:150` → `markers/marker.js:95`），宿主的问题桥只把
   `question_pending` 发给浏览器 WS，插件能订阅的 15 个事件里没有它。唯一缝隙是 `onToolEvent`：
   它带 `phase`/`toolName`（所以能知道「卡在等人」），**不带 `args`**（所以拿不到选项文字），
   也**不带 `sessionId`**（`agent-service.js:4813/4851`，所以提问推送的 `#s=` 靠 run 事件缓存的会话回填）。
   因此提醒只说「在等你」，选项得点推送回 cockpit 看。

6. **会话快照里的工具参数是 JSON 字符串 `argumentsText`，不是对象**（`serialize.js:161-172`），工具结果是
   独立消息 `role:"toolResult"`（`:385-392`）。只认 `input`/`args` 对象的话，「改了 N 个文件」在真机恒为空，
   而自造夹具（`input:{path}`）的测试照样全绿。写摘要类代码请照抄测试里的 `REAL_SNAP` 形状。
   超大参数会被宿主截断（`argumentsTruncated`）→ JSON.parse 失败，已退化成正则抠 `path`。

只有选择 `critical` 时才需要关键通知权限；仅用普通/时效性通知时无需开启关键通知权限。

## 开发

```bash
node --check index.mjs                             # 语法
node --test index.test.mjs                         # 单测（SDK 自带 createMockHost，无需起服务）
node /opt/homebrew/lib/node_modules/pi-web-ui/plugin-sdk/import-check.mjs .   # 客户端越界/缺失自检
# manifest 权威校验（严格模式，0 error / 0 warning 才算过）
node --input-type=module -e '
const { validatePluginManifest } = await import("/opt/homebrew/lib/node_modules/pi-web-ui/dist/server/plugin-manifest-validate.js");
const fs = await import("node:fs/promises");
const r = validatePluginManifest(JSON.parse(await fs.readFile("manifest.json", "utf8")), "bark-notify");
console.log("strict:", r.strict, "errors:", r.errors.length, "warnings:", r.warnings.length, JSON.stringify(r.permissions));'
pi-web-ui plugin upgrade-sdk bark-notify           # 升级宿主后刷新 SDK 拷贝
```
