/**
 * bark-notify — 任务事件 → Bark 推送（服务端入口）
 *
 * 只做两件事：
 *   1. 分级：把宿主 run 事件映射成 done / fail 两档，声音即优先级
 *      （glass=完成 · crow+critical=出错）。
 *   2. 投递：POST <server>/push + snake_case `device_key`。中文/emoji/换行原生支持，
 *      不需要 URL 编码 —— 这类精简版 bark-server 的 GET 路径式虽返 200，但走
 *      jq '@uri' 拼 URL 时非 ASCII 会变成字面量 "null"（踩过），故统一走 POST。
 * （原「需要你决策」档与 /ack 回环已删：当前宿主的 approval/question 消息只走
 *   客户端 WS 桥，不进插件可见的 onRunEvent，无法可靠触发。）
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
/** 数字设置取值：空串/非法 → 默认值；0 是显式合法值（如「不限时长」），与清空区分。 */
export function numSet(value, dflt) {
	const t = String(value ?? "").trim();
	if (t === "") return dflt;
	const n = Number(t);
	return Number.isFinite(n) ? n : dflt;
}
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

	switch (ev.type) {
		// run_start 不生成通知：handleEvent 只记开始时间用于「最短运行时长」判断
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
				mode: s.mode === "all" ? "all" : "important", // 旧版残留的 silent 值收敛到只推出错，不会升级后变全推
				minRunMs: numSet(s.minRunMinutes, 5) * 60_000, // 清空回默认 5 分钟，0 = 不限
				dedupSec: numSet(s.dedupSec, 300),
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
			// 同域相对路径自然继承反代域名，端口问题不存在（别写 :8787）；
			// 带会话 UUID 时拼 #s=<id>，点推送直达那条会话（前端 hash 路由认 sessionId，非 conversationId）
			const sid = String(note.sessionId || "").replace(/[^0-9a-zA-Z-]/g, "");
			return sid ? `${cfg.webBase}/#s=${sid}` : `${cfg.webBase}/`;
		};

		const sendJson = (res, status, payload) => {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
		};
		const record = (entry) => {
			recent.unshift({ ...entry, at: Date.now() });
			if (recent.length > 20) recent.length = 20;
		};

		/** 投递一条通知：先过档位/时长/去重等抑制门槛，真要投递了才查配置与授权。
		 *  顺序关键：被时长/档位过滤掉的事件本来就不会发，不该回头报「未配置」。 */
		async function notify(note, opts = {}) {
			if (!note) return { ok: false, skipped: "no-note" };
			const cfg = cfgOf();
			const mode = cfg.mode;
			const k = dedupeKey(note);
			const rec = (n, result, extra) => record({ kind: n.kind, title: n.title, result, ...extra });
			const release = () => dedup.delete(k); // 试了但没送达 → 释放去重标记，不吞重试机会
			if (mode === "important" && !opts.force && note.kind === "done") {
				rec(note, "filtered");
				return { ok: false, skipped: "mode-important" };
			}
			if (note.kind === "done" && !opts.force && cfg.minRunMs > 0 && (!Number.isFinite(opts.durationMs) || opts.durationMs <= cfg.minRunMs)) {
				return { ok: false, skipped: "too-fast" };
			}
			// 秒级去重
			const now = Date.now();
			if (cfg.dedupSec > 0 && !opts.bypassDedup) {
				const prev = dedup.get(k);
				if (prev && now - prev < cfg.dedupSec * 1000) { rec(note, "dedup"); return { ok: false, skipped: "dedup" }; }
				dedup.set(k, now);
				if (dedup.size > 500) for (const [hk, hv] of dedup) { if (now - hv > cfg.dedupSec * 1000) dedup.delete(hk); }
			}
			// 到这里是真要往手机发了：自架域名先确保授权（用户点同意即记住），批不下来才算问题
			if (!(await ensureNetGrant(cfg.server, { retry: opts.retryAuthorization }))) {
				const allowProblem = allowHint(cfg.server);
				if (allowProblem) {
					host.log("warn", allowProblem);
					rec(note, "not-allowlisted");
					release();
					return { ok: false, skipped: "not-allowlisted", hint: allowProblem };
				}
			}
			if (opts.retryAuthorization && (cfgOf().server !== cfg.server || cfgOf().barkKey !== cfg.barkKey)) {
				release();
				return { ok: false, skipped: "configuration-changed" };
			}
			const missing = missingCfg();
			if (missing.length) {
				const tip = `Bark 推送未配置：请填写 ${missing.join(" / ")}（设置 → 界面插件 → Bark 推送）`;
				host.notify("warning", tip, `Bark not configured: fill ${missing.join(" / ")}`);
				host.log("warn", tip);
				rec(note, "unconfigured");
				release();
				return { ok: false, skipped: "unconfigured", missing };
			}
			const payload = buildPayload(cfg, { ...note, url: note.url || pushUrlOf(cfg, note) });
			if (!payload) { host.log("warn", "barkKey 未配置（设置 → Bark 推送 → 设备密钥）"); release(); return { ok: false, skipped: "no-key" }; }
			try {
				// 走宿主受控出站 net.fetch（白名单/已授权威才放行）；旧宿主无 net 时退回裸 fetch
				const viaNet = typeof host.net?.fetch === "function";
				const res = await (viaNet ? host.net.fetch : host.fetch).call(viaNet ? host.net : host, `${cfg.server}/push`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
					timeoutMs: 15000,
				});
				// net.fetch 被拒时回 {ok:false,error:…}（无 status/text）；放行后才是 HTTP 响应形状
				const status = Number.isFinite(res?.status) ? res.status : 0;
				const text = typeof res?.text === "function" ? await res.text().catch(() => "") : String(res?.error ?? res?.message ?? "");
				const ok = status === 200 && /"code"\s*:\s*"?200"?/.test(text); // 兼容字符串 "200"（部分自架 server）
				rec(note, ok ? "sent" : status ? `http-${status}` : "net-denied", { detail: clip(text, 160) });
				host.log(ok ? "info" : "warn", `bark ${ok ? "ok" : "FAILED"} [${note.kind}|${payload.sound}|${payload.level}] ${note.title} ${ok ? "" : text.slice(0, 160)}`);
				if (!ok) release();
				return { ok, status, text: clip(text, 200) };
			} catch (err) {
				rec(note, "error", { detail: String(err?.message || err).slice(0, 160) });
				host.log("error", `bark 投递异常: ${String(err?.message || err).slice(0, 200)}`);
				release();
				return { ok: false, error: String(err?.message || err) };
			}
		}

		/** 事件入口：类型门 → 算耗时 → 取快照 → 分级 → 投递。门在前，高频事件（turn、tool、message 系列）不再白拉会话快照。 */
		const NOTIFIABLE = new Set(["run_end", "run_error", "agent_error"]);
		async function handleEvent(ev) {
			if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
			const cid = ev.conversationId || ev.sessionId || ev.clientId || "anon";
			if (ev.type === "run_start") {
				startedAt.set(cid, Date.now());
				if (startedAt.size > 200) { // 清遗忘键（run 未正常收尾）：只留近 24h
					const cut = Date.now() - 24 * 3600 * 1000;
					for (const [kc, vc] of startedAt) { if (vc < cut) startedAt.delete(kc); }
				}
				return;
			}
			if (!NOTIFIABLE.has(ev.type)) return;
			let durationMs;
			{
				const t0 = startedAt.get(cid);
				startedAt.delete(cid);
				if (t0 !== undefined) durationMs = Math.max(0, Date.now() - t0);
			}
			let snap = null;
			try {
				snap = host.getActiveConversation({ clientId: ev.clientId }) || host.getActiveConversation();
			} catch { /* 快照拿不到就用兜底名 */ }
			const project = pickProject(snap);
			const note = classifyEvent(ev, {
				project,
				durationMs,
				convId: shortId(cid),
			});
			if (!note) return;
			note.group = note.kind === "fail" ? "pi-fail" : "pi";
			note.sessionId = ev.sessionId || ""; // 宿主事件自带会话 UUID → 推送直达该会话
			await notify(note, { durationMs });
		}

		// 只订阅 onRunEvent：宿主 onToolEvent 载荷无 type 字段（phase/toolName 那套），永不产出通知，订了白烧 CPU
		const offRun = host.onRunEvent((ev) => { handleEvent(ev).catch((err) => host.log("error", String(err?.message || err))); });

		const curMode = () => cfgOf().mode;

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
		probe("net", () => (typeof host.net?.fetch === "function" || typeof host.fetch === "function" ? "ok" : "missing"));
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
		/** 外部推送简易限流：每 IP 每 10 分钟 ≤30 条。 */
		const extSends = new Map(); // ip → [ms,...]
		const rateOk = (req) => {
			const ip = String(req?.socket?.remoteAddress || req?.ip || "unknown");
			const now = Date.now(); const win = now - 10 * 60 * 1000;
			const arr = (extSends.get(ip) || []).filter((t) => t > win);
			extSends.set(ip, arr);
			if (extSends.size > 64) { for (const [ki, va] of extSends) { if (!va.some((t) => t > win)) extSends.delete(ki); } }
			if (arr.length >= 30) return false;
			arr.push(now);
			return true;
		};
		const deliver = async (body, res, req) => {
			if (!rateOk(req)) return sendJson(res, 429, { ok: false, error: "外部推送限流：每 10 分钟≤ 30 条" });
			const iconOverride = String(body.icon ?? "").trim() || undefined;
			const out = await notify({
				kind: body.kind || "done",
				title: clip(body.title || (iconOverride ? "🖼️ 外部推送（带图）" : "📣 外部推送"), SHORT_TITLE),
				body: clip(body.body || " ", SHORT_BODY),
				sound: body.sound || (iconOverride ? "bell" : "glass"), level: body.level || "active", archived: Boolean(body.archived ?? (body.quiet === "1" || body.quiet === true)),
				badge: Number.isFinite(Number(body.badge)) ? Number(body.badge) : 1,
				iconOverride,
				sessionId: String(body.session || body.sessionId || ""), // 可选：点推送直达指定会话
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
			if (req?.body && typeof req.body === "object") return void deliver(req.body, res, req);
			if (typeof req?.on !== "function") return sendJson(res, 400, { ok: false, error: "读不到请求体（宿主既未交 req.body 也未交流）" });
			let raw = "";
			let answered = false;
			req.on("data", (c) => {
				raw += c;
				if (raw.length > 65536 && !answered) { answered = true; sendJson(res, 413, { ok: false, error: "请求体过大（>64KB）" }); try { req.destroy?.(); } catch {} }
			});
			req.on("end", () => {
				if (answered) return;
				answered = true;
				let body = {};
				try { body = JSON.parse(raw || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
				void deliver(body, res, req);
			});
			req.on("error", () => { answered = true; });
		});
		host.route("GET", "/send", (req, res) => void deliver(queryBody(req), res, req));

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
		});

		const keyState = cfgOf().barkKey ? "已配" : "未配 → 设置里填设备密钥";
		if (capsBlocked.length) host.log("warn", `能力被门控：${capsBlocked.map(([k, v]) => `${k}=${v}`).join(", ")} —— 往 manifest.permissions 里补上对应能力族再重装`);
		host.log("info", `bark-notify 就绪（模式 ${curMode()}，密钥${keyState}，能力 ${Object.keys(caps).length - capsBlocked.length}/${Object.keys(caps).length} 可用）`);

		/** 上线回执：加载完直接推一条到手机（胉眼节流 10 分钟）。
		 *  用户刷新完浏览器秒知生效与否，不用开终端 curl、也不用翻宿主日志。 */
		const bootMissing = missingCfg();
		const bootPing = () => {
			const bootAt = Number(host.storage.get("boot:lastPing", 0) || 0);
			if (Number.isFinite(bootAt) && Date.now() - bootAt <= 10 * 60 * 1000) return;
			host.storage.set("boot:lastPing", Date.now());
			notify({
				kind: capsBlocked.length ? "ask" : "done",
				title: capsBlocked.length ? `⚠️ bark-notify 已加载（${capsBlocked.length} 项能力被拒）` : `🔌 bark-notify 已加载`,
				body: capsBlocked.length
					? `${capsBlocked.map(([ck, cv]) => `${ck}: ${cv}`).join("\n")}\n往 manifest.permissions 补上对应能力族再重装` 
					: `能力 ${Object.keys(caps).length}/${Object.keys(caps).length} 可用 · 档位 ${curMode()}\n密钥${keyState}`,
				sound: capsBlocked.length ? "cicada" : "glass",
				level: "active", group: "pi", badge: 0,
			}, { force: true }).catch(() => {});
		};
		if (bootMissing.length) {
			// 缺必填不推手机（推也推不出去），且不记去重时间：刷新一次提醒一次，直到填好
			const tip = `🔌 bark-notify 已加载，但缺必填：${bootMissing.join(" / ")}`;
			host.notify("warning", tip, tip);
			host.log("warn", tip);
		} else {
			// 不 await：授权弹框最长挂 120s，拖住 activate = 期间路由 404 + run 事件扇出不到；改异步跟进
			void ensureNetGrant(cfgOf().server).then((ok) => {
				const bootAllow = ok ? "" : allowHint(cfgOf().server);
				if (bootAllow) {
					const tip = `🔌 bark-notify 已加载，但发不出去：${bootAllow}`;
					host.notify("warning", tip, tip);
					host.log("warn", tip);
					return;
				}
				bootPing();
			}).catch(() => {});
		}

		return () => {
			for (const off of [offRun, offToolReg, offSettings]) { try { off?.(); } catch {} }
		};
	},
});
