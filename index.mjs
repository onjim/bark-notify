/**
 * bark-notify — 任务事件 → Bark 推送（服务端入口）
 *
 * 只做三件事：
 *   1. 分级：把宿主 run/tool 事件映射成 done / ask / fail / start 四档，声音即优先级
 *      （glass=完成 · cicada=要你决策 · crow+critical=出错 · silence=只记账）。
 *   2. 投递：POST <server>/push + snake_case `device_key`。中文/emoji/换行原生支持，
 *      不需要 URL 编码 —— 这类精简版 bark-server 的 GET 路径式虽返 200，但走
 *      jq '@uri' 拼 URL 时非 ASCII 会变成字面量 "null"（踩过），故统一走 POST。
 *   3. 回环：GET /plugins-api/bark-notify/ack?t=<id> —— 手机上点一下推送即视为确认，
 *      这是单向 APNs 通道里唯一能形成的反馈闭环（返回极简 HTML，不留 JSON 白页）。
 *
 * 前台不打扰：最近 muteWhenActive 秒内浏览器有过上行消息 → 降级为站内提示（不推手机）。
 */
import { definePlugin } from "./sdk/index.mjs";

/** manifest 里的兜底名单（与 netAllowlist 保持一致）：只放公共默认域名。
 *  个人自架域名走 host.requestPermission 动态授权（用户点一次同意，宿主记住），
 *  不写进公共仓库的 manifest。 */
const ALLOWED_HOSTS = ["api.day.app", "example.com", "github.com", "avatars.githubusercontent.com"];
const hostOf = (urlLike) => { try { return new URL(String(urlLike || "")).hostname.toLowerCase(); } catch { return ""; } };
const looksUrl = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || "").trim());

/**
 * 项目名提取。日志里踩过：会话标题刚好是用户粘进来的一条 URL（截断后成了
 * 「✅ https://bark.day.app/#/… · 任务完成」，锁屏完全看不出是哪个项目）。
 * 所以：cwd basename 优先，标题得既不是 URL 也不超长才用，否则一律「pi」。
 */
export function pickProject(snap) {
	const cwd = baseName(snap?.cwd);
	if (cwd && !looksUrl(cwd) && cwd.length <= 40) return cwd;
	const title = String(snap?.title ?? "").trim();
	if (title && !looksUrl(title) && title.length <= 30) return title;
	return "pi";
}

const SHORT_TITLE = 78;
const SHORT_BODY = 480;

const clip = (value, max) => {
	const text = String(value ?? "").replace(/[ \t]+\n/g, "\n").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const shortId = (value) => String(value ?? "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) || "unknown";
const baseName = (pathLike) => String(pathLike ?? "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
const fmtDur = (ms) => {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
	const m = Math.floor(ms / 60_000);
	const s = String(Math.round((ms % 60_000) / 1000)).padStart(2, "0");
	return m < 60 ? `${m}m${s}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/** stopReason 里算「出问题」的那些（其余一律当正常收尾）。 */
const FAIL_STOP = new Set(["error", "aborted", "abort", "cancelled", "canceled", "timeout", "refusal"]);
const WARN_STOP = new Set(["length", "content_filter", "max_tokens", "context_length"]);

/**
 * 事件 → 通知意图（纯函数，无 IO，可单测）。
 * @param ev 宿主 onRunEvent/onToolEvent 载荷：{type,conversationId,sessionId,clientId,runId,stopReason,at,…}
 * @param ctx {project, durationMs, convId, conversationTitle}
 */
export function classifyEvent(ev, ctx = {}) {
	if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return null;
	const proj = ctx.project || "pi";
	const dur = fmtDur(ctx.durationMs);
	const tail = [dur && `耗时 ${dur}`, ctx.convId && `会话 ${ctx.convId}`].filter(Boolean).join(" · ");
	const id = shortId(ctx.convId || ev.conversationId || ev.sessionId);

	switch (ev.type) {
		case "run_start":
			return {
				kind: "start",
				title: clip(`⏳ ${proj} · 开始`, SHORT_TITLE),
				body: clip(ev.task || ev.prompt || "任务已启动", SHORT_BODY),
				sound: "silence", level: "active", archived: true, badge: 0,
			};
		case "run_end": {
			const stop = String(ev.stopReason || "").trim().toLowerCase();
			if (FAIL_STOP.has(stop)) {
				return {
					kind: "fail",
					title: clip(`❌ ${proj} · 中断(${stop})`, SHORT_TITLE),
					body: clip([dur && `耗时 ${dur}`, `stopReason=${stop}`, "回到 cockpit 看完整轨迹"].filter(Boolean).join("\n"), SHORT_BODY),
					sound: "crow", level: "critical", archived: false, badge: 1,
				};
			}
			if (WARN_STOP.has(stop)) {
				return {
					kind: "fail",
					title: clip(`⚠️ ${proj} · 提前收尾(${stop})`, SHORT_TITLE),
					body: clip([dur && `耗时 ${dur}`, "输出被截断或过滤，可能要续一句"].filter(Boolean).join("\n"), SHORT_BODY),
					sound: "bell", level: "timeSensitive", archived: false, badge: 1,
				};
			}
			return {
				kind: "done",
				title: clip(`✅ ${proj} · 任务完成`, SHORT_TITLE),
				body: clip([dur || "已完成", tail && tail.replace(/ · /g, "\n")].filter(Boolean).join("\n"), SHORT_BODY),
				sound: "glass", level: "active", archived: false, badge: 1,
			};
		}
		case "tool_approval_pending": {
			const cmd = clip(ev.command ?? ev.toolName ?? ev.name ?? "命令", 120);
			return {
				kind: "ask",
				title: clip(`🙋 等批准 · ${proj}`, SHORT_TITLE),
				body: clip(`${cmd}\n${[dur && `已等 ${dur}`, "点这条推送 = 标记已看到"].filter(Boolean).join("\n")}`, SHORT_BODY),
				sound: "cicada", level: "timeSensitive", archived: false, badge: 1,
				ack: id,
			};
		}
		case "question_pending": {
			const q = clip(ev.question ?? ev.text ?? "AI 在等你回答", 160);
			return {
				kind: "ask",
				title: clip(`🙋 需要你回答 · ${proj}`, SHORT_TITLE),
				body: clip(`${q}\n${[dur && `已等 ${dur}`, "点推送直达会话选项"].filter(Boolean).join("\n")}`, SHORT_BODY),
				sound: "cicada", level: "timeSensitive", archived: false, badge: 1,
				ack: id,
			};
		}
		case "run_error":
		case "agent_error":
			return {
				kind: "fail",
				title: clip(`❌ ${proj} · 报错`, SHORT_TITLE),
				body: clip(clip(ev.error ?? ev.message ?? "未知错误", SHORT_BODY - 40) + (tail ? `\n${tail}` : ""), SHORT_BODY),
				sound: "crow", level: "critical", archived: false, badge: 1,
			};
		default:
			return null; // turn_end / tool_delta / … 一律不推，防刷屏
	}
}

/** 通知意图 → Bark POST payload（snake_case，本实例唯一可靠通道）。 */
export function buildPayload(cfg, note) {
	const key = String(cfg.barkKey || "").trim();
	if (!key) return null;
	const payload = {
		device_key: key,
		title: note.title,
		body: note.body || " ",
		group: note.group || (note.kind === "ask" ? "pi-ask" : note.kind === "fail" ? "pi-fail" : "pi"),
		badge: Number.isFinite(note.badge) ? note.badge : 1,
		sound: note.sound || "glass",
		level: note.level || "active",
		archived: Boolean(note.archived),
	};
	// 单条图标优先于设置里的 icon；两处都空就不带该字段
	const icon = String(note.iconOverride || cfg.icon || "").trim();
	if (icon) payload.icon = icon;
	if (note.url) payload.url = note.url;
	return payload;
}

/** 去重键：同标题+正文在窗口内只发一次（防故障时连环轰炸）。 */
export function dedupeKey(note) {
	return `${note.kind || ""}|${note.title}|${note.body}`;
}

export default definePlugin({
	async activate(host) {
		/** —— 运行时状态（全部内存，重启即清；配置以设置面板为准）—— */
		const startedAt = new Map();          // conversationId → run 起始 ms
		const dedup = new Map();             // hash → 最近投递 ms
		const recent = [];                  // 最近 20 条投递记录（/status 用）
		let lastClientActivity = 0;
		let morningStop = null;

		const cfgOf = () => {
			const s = host.getSettings() || {};
			const clean = (v) => String(v ?? "").trim().replace(/\/+$/, "");
			const secret = (k) => {
				try { return String(host.secrets.get(`setting:${k}`) ?? host.secrets.get(k) ?? s[k] ?? "").trim(); }
				catch { return String(s[k] ?? "").trim(); }
			};
			return {
				// 地址和密钥均由使用者配置，不提供默认值
				server: clean(s.server),
				barkKey: secret("barkKey"),
				webBase: clean(s.webBase),
				icon: clean(s.icon),
				mode: s.mode || "important",
				muteWhenActive: Number(s.muteWhenActive ?? 120),
				minRunMs: Number(s.minRunMs ?? 20000),
				dedupSec: Number(s.dedupSec ?? 300),
				morningCron: String(s.morningCron ?? "").trim(),
			};
		};
		/** 缺必填项 / 域名不在出站白名单：两条都让人当场看到，而不是默默不发 */
		const missingCfg = () => ["server", "barkKey"].filter((k) => !String(cfgOf()[k] || "").trim());
		/** 已批过 / 已问过的主机：批过的不再打扰，被拒的也不再每轮重弹。 */
		const netGranted = new Set();
		const netAsked = new Set();
		const netPending = new Map();
		/** 向宿主申请该主机的出站授权（用户可在确认框记住）。mock 环境直接回 false。 */
		async function ensureNetGrant(server, { retry = false } = {}) {
			const h = hostOf(server);
			if (!h) return false;
			if (ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`))) return true;
			if (netPending.has(h)) return netPending.get(h);
			if (retry) { netAsked.delete(h); netGranted.delete(h); }
			if (netGranted.has(h)) return true;
			if (netAsked.has(h)) return false;
			netAsked.add(h);
			const pending = (async () => {
				try {
					const ok = await host.requestPermission({
						family: "net",
						hosts: [h],
						reason: "Bark 推送需要访问你自建的 Bark 服务器",
					});
					if (ok) {
						netGranted.add(h);
						host.log("info", `已获准出站：${h}`);
					} else {
						host.log("warn", `未获准出站：${h}（设置 → 界面插件 → Bark 推送 → 已授权能力里放行，或手动重试）`);
					}
					return Boolean(ok);
				} catch (err) {
					host.log("warn", `申请出站授权失败：${String(err?.message || err).slice(0, 160)}`);
					return false;
				}
			})();
			netPending.set(h, pending);
			try { return await pending; } finally { netPending.delete(h); }
		}
		const allowHint = (server) => {
			const h = hostOf(server);
			if (!h) return "";
			if (ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`)) || netGranted.has(h)) return "";
			return `「${h}」尚未获准出站（确认框点放行即可，无需改 manifest；已拒过则去设置 → 已授权能力放行，或加进 manifest.netAllowlist 再重装）`;
		};

		const pushUrlOf = (cfg, note) => {
			if (!cfg.webBase) return "";
			// 同域相对路径自然继承反代域名，端口问题不存在（别写 :8787）
			return note.ack ? `${cfg.webBase}/plugins-api/bark-notify/ack?t=${encodeURIComponent(note.ack)}` : `${cfg.webBase}/`;
		};

		const sendJson = (res, status, payload) => {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
		};
		const record = (entry) => {
			recent.unshift({ ...entry, at: Date.now() });
			if (recent.length > 20) recent.length = 20;
		};

		/** 投递一条通知（含档位过滤、前台静音、去重）。 */
		async function notify(note, opts = {}) {
			if (!note) return { ok: false, skipped: "no-note" };
			const cfg = cfgOf();
			const missing = missingCfg();
			if (missing.length) {
				const tip = `Bark 推送未配置：请填写 ${missing.join(" / ")}（设置 → 界面插件 → Bark 推送）`;
				host.notify("warning", tip, `Bark not configured: fill ${missing.join(" / ")}`);
				host.log("warn", tip);
				record({ ...note, result: "unconfigured" });
				return { ok: false, skipped: "unconfigured", missing };
			}
			// 自架域名：先向宿主申请一次出站授权（用户点同意即记住），批不下来才算问题
			if (!(await ensureNetGrant(cfg.server, { retry: opts.retryAuthorization }))) {
				const allowProblem = allowHint(cfg.server);
				if (allowProblem) {
					host.log("warn", allowProblem);
					record({ ...note, result: "not-allowlisted" });
					return { ok: false, skipped: "not-allowlisted", hint: allowProblem };
				}
			}
			if (opts.retryAuthorization && (cfgOf().server !== cfg.server || cfgOf().barkKey !== cfg.barkKey)) {
				return { ok: false, skipped: "configuration-changed" };
			}
			const mode = cfg.mode;
			if (mode === "silent" && !opts.force) { record({ ...note, result: "muted" }); return { ok: false, skipped: "mode-silent" }; }
			if (mode === "important" && !opts.force && (note.kind === "done" || note.kind === "start")) {
				record({ ...note, result: "filtered" });
				return { ok: false, skipped: "mode-important" };
			}
			if (note.kind === "done" && !opts.force && cfg.minRunMs > 0 && Number.isFinite(startedAt._lastDur) && startedAt._lastDur < cfg.minRunMs) {
				return { ok: false, skipped: "too-fast" };
			}
			// 秒级去重
			const k = dedupeKey(note);
			const now = Date.now();
			if (cfg.dedupSec > 0 && !opts.bypassDedup) {
				const prev = dedup.get(k);
				if (prev && now - prev < cfg.dedupSec * 1000) { record({ ...note, result: "dedup" }); return { ok: false, skipped: "dedup" }; }
				dedup.set(k, now);
				if (dedup.size > 500) for (const [hk, hv] of dedup) { if (now - hv > cfg.dedupSec * 1000) dedup.delete(hk); }
			}
			// 前台降级：你正在浏览器里操作 → 站内提示，手机不响
			const active = cfg.muteWhenActive > 0 && lastClientActivity > 0 && now - lastClientActivity < cfg.muteWhenActive * 1000;
			const payload = buildPayload(cfg, { ...note, url: note.url || pushUrlOf(cfg, note) });
			if (!payload) { host.log("warn", "barkKey 未配置（设置 → Bark 推送 → 设备密钥）"); return { ok: false, skipped: "no-key" }; }
			if (active && !opts.force) {
				host.notify("info", `${note.title}（站内提示：手机在你操作时不响）`, note.title);
				record({ ...note, result: "in-app" });
				return { ok: false, skipped: "tab-active" };
			}
			try {
				const res = await host.fetch(`${cfg.server}/push`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
					timeoutMs: 15000,
				});
				const text = await res.text().catch(() => "");
				const ok = res.status === 200 && /"code"\s*:\s*200/.test(text);
				record({ kind: note.kind, title: note.title, result: ok ? "sent" : `http-${res.status}`, detail: clip(text, 160) });
				host.log(ok ? "info" : "warn", `bark ${ok ? "ok" : "FAILED"} [${note.kind}|${payload.sound}|${payload.level}] ${note.title} ${ok ? "" : text.slice(0, 160)}`);
				return { ok, status: res.status, text: clip(text, 200) };
			} catch (err) {
				record({ kind: note.kind, title: note.title, result: "error", detail: String(err?.message || err).slice(0, 160) });
				host.log("error", `bark 投递异常: ${String(err?.message || err).slice(0, 200)}`);
				return { ok: false, error: String(err?.message || err) };
			}
		}

		/** 事件入口：算耗时 → 分级 → 投递。 */
		async function handleEvent(ev, source = "run") {
			if (!ev || typeof ev !== "object") return;
			const cid = ev.conversationId || ev.sessionId || ev.clientId || "anon";
			if (ev.type === "run_start") { startedAt.set(cid, Date.now()); }
			const durationMs = startedAt._lastDurCache?.cid === cid ? startedAt._lastDurCache.ms : undefined;
			if (ev.type === "run_end" || ev.type === "run_error" || ev.type === "agent_error") {
				const t0 = startedAt.get(cid);
				startedAt.delete(cid);
				if (t0) { startedAt._lastDur = Date.now() - t0; startedAt._lastDurCache = { cid, ms: startedAt._lastDur }; }
			}
			let snap = null;
			try {
				snap = host.getActiveConversation({ clientId: ev.clientId }) || host.getActiveConversation();
			} catch { /* 快照拿不到就用兜底名 */ }
			const project = pickProject(snap);
			const note = classifyEvent(ev, {
				project,
				durationMs: Number.isFinite(startedAt._lastDurCache?.ms) && startedAt._lastDurCache?.cid === cid ? startedAt._lastDurCache.ms : durationMs,
				convId: shortId(cid),
			});
			if (!note) return;
			note.group = note.kind === "ask" ? "pi-ask" : note.kind === "fail" ? "pi-fail" : source === "tool" ? "pi-tool" : "pi";
			await notify(note);
		}

		const offRun = host.onRunEvent((ev) => { handleEvent(ev, "run").catch((err) => host.log("error", String(err?.message || err))); });
		const offTool = host.onToolEvent?.((ev) => { handleEvent(ev, "tool").catch(() => {}); });
		// 客户端上行消息统一交给下面的 handleUpstream（它顺手记「人在屏前」）

		const curMode = () => cfgOf().mode;

		function handleUpstream(msg, reply) {
			lastClientActivity = Date.now();
			const action = typeof msg?.action === "string" ? msg.action : "";
			if (action === "bark-notify:status") { reply?.({ ok: true, mode: curMode(), recent: recent.slice(0, 10), hasKey: Boolean(cfgOf().barkKey), icon: cfgOf().icon || null, missing: missingCfg(), capabilities: caps }); return; }
		}
		// 能回包的优先；只有 onMessage（旧宿主/mock）时走 fire-and-forget，重复投递由去重窗口吃掉
		const offClient = host.onClientMessage?.((msg, reply) => handleUpstream(msg, reply));
		const offUpstream = host.onMessage((msg) => handleUpstream(msg, () => {}));

		/** 能力自检：权限族声明不全时，调用会被宿主静默拒（只留一行日志），翻志很痛。
		 *  这里逐项探一下，结果挂到 /ping 与设置面板，拒了当场就知道是哪个族。 */
		const caps = {};
		const probe = (family, fn) => {
			try {
				const out = fn();
				const denied = out && typeof out === "object" && (out.ok === false || out.allowed === false || /请求被拒|denied|permission|权限/i.test(String(out.error ?? out.message ?? "")));
				caps[family] = denied ? `denied: ${clip(out.error ?? out.message ?? "ok:false", 70)}` : "ok";
			} catch (err) { caps[family] = `error: ${clip(String(err?.message ?? err), 70)}`; }
		};
		probe("storage", () => { host.storage.set("cap:probe", 1); return host.storage.get("cap:probe"); });
		probe("secrets", () => { host.secrets.has("cap:probe"); return "ok"; });
		probe("notify", () => (typeof host.notify === "function" ? "ok" : "missing"));
		probe("chat", () => { host.getActiveConversation(); return "ok"; });
		probe("tools", () => (typeof (host.registerAgentTool ?? host.registerTool) === "function" ? "ok" : "missing"));
		probe("http", () => (typeof host.route === "function" ? "ok" : "missing"));
		probe("schedule", () => (typeof host.schedule === "function" ? "ok" : "missing（无能力族，靠自然可用）"));
		probe("net", () => (typeof host.fetch === "function" ? "ok" : "missing"));
		probe("ui", () => (typeof host.ui === "object" ? "ok" : "missing"));
		const capsBlocked = Object.entries(caps).filter(([, v]) => v !== "ok");

		/** —— 外部/手机回环 HTTP（挂在 /plugins-api/bark-notify/*）—— */
		host.route("GET", "/ping", (_req, res) => sendJson(res, 200, { ok: true, id: "bark-notify", configured: missingCfg().length === 0, missing: missingCfg(), allowlistHint: allowHint(cfgOf().server) || null, mode: curMode(), hasKey: Boolean(cfgOf().barkKey), server: cfgOf().server || null, webBase: cfgOf().webBase || null, netAllowlist: [...ALLOWED_HOSTS, ...netGranted], permissions: ["net", "secrets", "storage", "ui", "http", "tools", "notify", "chat"], capabilities: caps, blocked: capsBlocked }));
		host.route("GET", "/status", (_req, res) => sendJson(res, 200, { ok: true, mode: curMode(), recent, icon: cfgOf().icon || null, hasKey: Boolean(cfgOf().barkKey), configured: missingCfg().length === 0, missing: missingCfg(), allowlistHint: allowHint(cfgOf().server) || null }));
		host.route("POST", "/test", async (req, res) => {
			const contentType = String(req?.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
			if (contentType !== "application/json") return sendJson(res, 415, { ok: false, error: "application/json required" });
			const out = await notify({ kind: "done", title: "Bark 推送测试", body: "配置测试通知", sound: "glass", level: "active", badge: 1 },
				{ force: true, bypassDedup: true, retryAuthorization: true });
			const result = { ok: out.ok, ...(out.skipped ? { reason: out.skipped } : {}), ...(out.missing ? { missing: out.missing } : {}), ...(out.status ? { status: out.status } : {}) };
			if (!out.ok && !out.skipped && !out.status) result.reason = "delivery-failed";
			sendJson(res, out.ok ? 200 : 502, result);
		});
		/** 外部推一条：共用插件里的配置（脚本/其它机器不用各自存 key）。
		 *  三种进数据都要接：宿主 json parser 已把 body 消耗成 req.body（主流情况）、
		 *  原始流（未接 parser 时）、以及 GET query（手机上直接输 URL 就能测）。 */
		const deliver = async (body, res) => {
			const iconOverride = String(body.icon ?? "").trim() || undefined;
			const out = await notify({
				kind: body.kind || "done",
				title: clip(body.title || (iconOverride ? "🖼️ 外部推送（带图）" : "📣 外部推送"), SHORT_TITLE),
				body: clip(body.body || " ", SHORT_BODY),
				sound: body.sound || (iconOverride ? "bell" : "glass"), level: body.level || "active", archived: Boolean(body.archived ?? (body.quiet === "1" || body.quiet === true)),
				badge: Number.isFinite(Number(body.badge)) ? Number(body.badge) : 1,
				iconOverride,
			}, { force: true });
			sendJson(res, out.ok ? 200 : 502, out);
		};
		const queryBody = (req) => {
			const q = new URLSearchParams(String(req?.url || "").split("?")[1] || "");
			const out = {};
			for (const [k, v] of q) out[k] = v;
			return out;
		};
		host.route("POST", "/send", (req, res) => {
			if (req?.body && typeof req.body === "object") return void deliver(req.body, res);
			if (typeof req?.on !== "function") return sendJson(res, 400, { ok: false, error: "读不到请求体（宿主既未交 req.body 也未交流）" });
			let raw = "";
			req.on("data", (c) => { raw += c; });
			req.on("end", () => {
				let body = {};
				try { body = JSON.parse(raw || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
				void deliver(body, res);
			});
		});
		host.route("GET", "/send", (req, res) => void deliver(queryBody(req), res));
		host.route("GET", "/ack", (req, res) => {
			const t = String(req.url || "").match(/[?&]t=([^&]+)/)?.[1] || "";
			host.storage.set(`ack:${t}`, Date.now());
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>已确认</title><body style="font:16px/1.6 -apple-system,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:44px">✅</div><p>已标记看到${t ? ` <code style="opacity:.6">${decodeURIComponent(t)}</code>` : ""}</p><p><a href="${cfgOf().webBase || "/"}" style="color:#7fd1ff">回到 cockpit</a></p></div>`);
		});

		/** —— AI 可用的工具 + 斜杠命令 —— */
		const toolDef = {
			name: "bark_notify",
			label: "Bark 推送",
			description: "给用户手机推一条 Bark 通知。适合：长任务完成、需要用户在手机上决策、跑挂了。level=critical 可穿透静音/专注模式。",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "锁屏第一行，建议带状态 emoji，≤40 字" },
					body: { type: "string", description: "关键数字/下一步动作，可用 \\n 换行" },
					level: { type: "string", enum: ["active", "timeSensitive", "critical"], description: "默认 active；critical 穿透静音" },
					sound: { type: "string", description: "glass/cicada/crow/bell/silence 或外链 mp3 URL" },
					group: { type: "string", description: "分组，如 pi / ci / home" },
					quiet: { type: "boolean", description: "true = 静默归档，只记账不弹" },
					icon: { type: "string", description: "本条临时图标 URL（空 = 用设置里的 icon；≥150×150 PNG）" },
				},
				required: ["title"],
			},
			// 两种宿主签名并存：registerAgentTool → execute(toolCallId, params)；registerTool → execute(args)
			execute: async (...args) => {
				const raw = args.length >= 2 && args[1] && typeof args[1] === "object" ? args[1] : args[0];
				const p = raw && typeof raw === "object" ? raw : {};
				const out = await notify({
					kind: p.level === "critical" ? "fail" : "done",
					title: clip(p.title || "🔔 推送", SHORT_TITLE),
					body: clip(p.body || "", SHORT_BODY),
					sound: p.quiet ? "silence" : p.sound || "glass",
					level: p.level || "active",
					group: p.group || "pi",
					archived: Boolean(p.quiet),
					iconOverride: String(p.icon || "").trim() || undefined,
					badge: p.quiet ? 0 : 1,
				}, { force: !p.quiet });
				return { content: [{ type: "text", text: out.ok ? "已推送 ✅" : `未推送：${out.skipped || out.error || out.status || "unknown"}` }] };
			},
		};
		// 真宿主只有 registerAgentTool，SDK 声明的 registerTool 在 mock 里没有 → 两者兜底
		const regToolFn = typeof host.registerAgentTool === "function" ? host.registerAgentTool : host.registerTool;
		const offToolReg = typeof regToolFn === "function" ? regToolFn.call(host, toolDef) : undefined;
		if (regToolFn === undefined) host.log("warn", "宿主无 registerAgentTool/registerTool，AI 推送工具未注册");
		/** —— 晨报定时任务（cron 空 = 关闭；设置改动后重挂）—— */
		function remountMorning() {
			try { morningStop?.(); } catch {}
			morningStop = null;
			const cron = cfgOf().morningCron;
			if (!cron) return;
			morningStop = host.schedule(cron, () => {
				const fails = recent.filter((r) => r.result === "sent" && r.kind === "fail").length;
				notify({
					kind: "done", title: `🌅 晨报 · ${new Date().toLocaleDateString("zh-CN")}`,
					body: `昨日站内事件 ${recent.length} 条，其中投递失败/中断 ${fails} 条\n档位 ${curMode()} · 点击回 cockpit`,
					sound: "glass", level: "active", group: "pi", badge: recent.length,
				}, { force: true });
			}, { id: "bark-notify-morning", label: "Bark 晨报", persistent: true, catchUp: "skip" });
		}
		remountMorning();
		let lastServerHost = hostOf(cfgOf().server);
		const offSettings = host.onSettingsChanged(() => {
			const h = hostOf(cfgOf().server);
			// 换了 Bark 域名：新域名可以重新申请一次授权
			if (h !== lastServerHost) {
				lastServerHost = h;
				if (h) void ensureNetGrant(cfgOf().server, { retry: true }).then((ok) => {
					if (hostOf(cfgOf().server) !== h) return;
					if (ok) host.log("info", `Bark 服务器出站授权已就绪：${h}`);
					else host.notify("warning", `Bark 服务器出站授权未完成，请在已授权能力中检查，或手动重试。`, "Bark network authorization is not ready.");
				});
			}
			remountMorning();
		});

		const keyState = cfgOf().barkKey ? "已配" : "未配 → 设置里填设备密钥";
		if (capsBlocked.length) host.log("warn", `能力被门控：${capsBlocked.map(([k, v]) => `${k}=${v}`).join(", ")} —— 往 manifest.permissions 里补上对应能力族再重装`);
		host.log("info", `bark-notify 就绪（模式 ${curMode()}，密钥${keyState}，能力 ${Object.keys(caps).length - capsBlocked.length}/${Object.keys(caps).length} 可用）`);

		/** 上线回执：加载完直接推一条到手机（胉眼节流 10 分钟）。
		 *  用户刷新完浏览器秒知生效与否，不用开终端 curl、也不用翻宿主日志。 */
		const bootAt = Number(host.storage.get("boot:lastPing", 0) || 0);
		const bootMissing = missingCfg();
		// 先申请一次（自架域名在此弹框），批下来就不算问题
		await ensureNetGrant(cfgOf().server).catch(() => {});
		const bootAllow = allowHint(cfgOf().server);
		if (bootMissing.length || bootAllow) {
			// 不齐就不推手机（推也推不出去），且不记去重时间：刷新一次提醒一次，直到填好
			const tip = bootMissing.length ? `🔌 bark-notify 已加载，但缺必填：${bootMissing.join(" / ")}` : `🔌 bark-notify 已加载，但发不出去：${bootAllow}`;
			host.notify("warning", tip, tip);
			host.log("warn", tip);
		} else if (!Number.isFinite(bootAt) || Date.now() - bootAt > 10 * 60 * 1000) {
			host.storage.set("boot:lastPing", Date.now());
			notify({
				kind: capsBlocked.length ? "ask" : "done",
				title: capsBlocked.length ? `⚠️ bark-notify 已加载（${capsBlocked.length} 项能力被拒）` : `🔌 bark-notify 已加载`,
				body: capsBlocked.length
					? `${capsBlocked.map(([k, v]) => `${k}: ${v}`).join("\n")}\n往 manifest.permissions 补上对应能力族再重装` 
					: `能力 ${Object.keys(caps).length}/${Object.keys(caps).length} 可用 · 档位 ${curMode()}\n密钥${keyState}`,
				sound: capsBlocked.length ? "cicada" : "glass",
				level: "active", group: "pi", badge: 0,
			}, { force: true }).catch(() => {});
		}

		return () => {
			for (const off of [offRun, offTool, offUpstream, offClient, offToolReg, offSettings]) { try { off?.(); } catch {} }
			try { morningStop?.(); } catch {}
		};
	},
});
