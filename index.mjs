/**
 * bark-notify — 任务事件 → Bark 推送（服务端入口）
 *
 * 只做两件事：
 *   1. 分类：完成 / 异常中断 / 提前收尾 / 等待回答 / 服务提示，声音区分类型，
 *      每类独立配置 active / timeSensitive / critical（默认普通提示）。
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
const LEVELS = new Set(["active", "timeSensitive", "critical"]);
const normalizeLevel = (value) => LEVELS.has(value) ? value : "active";
// 自动通知按分类设置；手动推送逐条指定。静默归档优先，不得因 critical 穿透静音。
const levelOf = (cfg, note) => note.archived ? "active" : normalizeLevel(note.category ? cfg.levels?.[note.category] : note.level);

const clip = (value, max) => {
	const text = String(value ?? "").replace(/[ \t]+\n/g, "\n").trim();
	if ([...text].length <= max) return text;
	return `${[...text].slice(0, max - 1).join("")}…`;
};
/** 推送正文来自会话/工具输出，先做最小化脱敏，避免把常见凭据带到 Bark。 */
export function redactText(value) {
	return String(value ?? "")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "‹redacted›")
		.replace(/\b(?:(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "‹redacted›")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "‹redacted›")
		.replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)([^\s,;]+)/gi, "$1‹redacted›");
}
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

// ── 会话快照 → 本轮产出摘要 ──
// 锁屏展开也就 4 行（中文每行 ~18 字），所以不求全，只把「干了什么 / 质量 / 下一步」挑值钱的塞。
// 全部写成纯函数，不起宿主也能测。
const blocksOf = (msg) => (Array.isArray(msg?.content) ? msg.content : []);
const isToolCall = (b) => Boolean(b && (b.type === "toolCall" || b.type === "tool_use" || b.type === "tool-call"));
const isToolResult = (b) => Boolean(b && (b.type === "toolResult" || b.type === "tool_result" || b.type === "tool-result"));
const toolNameOf = (b) => String(b?.name ?? b?.toolName ?? b?.tool ?? "").trim();
/**
 * 工具参数取对象：自造/mock 夹具给对象（input/args/…），真宿主给的是 **JSON 字符串**
 * `argumentsText`（serialize.js:161-172），只认对象会让文件清单在真机恒为空。
 * 超大参数宿主会截断（argumentsTruncated）→ JSON.parse 失败，退化成正则抠 path。
 */
const PATH_KEY_RE = /"(?:path|file_path|filePath|target|filename|notebook_path)"\s*:\s*("(?:\\.|[^"\\]){1,400}")/;
const toolArgsOf = (b) => {
	const a = b?.input ?? b?.args ?? b?.arguments ?? b?.params ?? b?.parameters;
	if (a && typeof a === "object") return a;
	if (typeof b?.argumentsText === "string") {
		try {
			const o = JSON.parse(b.argumentsText);
			if (o && typeof o === "object") return o;
		} catch {
			if (b.argumentsTruncated === true) {
				const m = b.argumentsText.match(PATH_KEY_RE);
				if (m) { try { return { path: JSON.parse(m[1]) }; } catch { /* 不猜损坏的转义 */ } }
			}
		}
	}
	return {};
};
const textOf = (b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "");
const resultTextOf = (b) => (isToolResult(b) ? blocksOf(b).map(textOf).join("\n") || (typeof b?.text === "string" ? b.text : "") : "");

/** 取首句（按中英文句末标点切），锁屏首行靠它。 */
export function firstSentence(value, max = 72) {
	const t = String(value || "").replace(/\s+/g, " ").trim();
	if (!t) return "";
	const m = t.match(/^.{1,300}?(?:[。！？!?;；]|\.\s|$)/);   // 保留句末标点，锁屏读起来自然
	const sent = (m ? m[0] : t).trim();
	return clip(sent, max);
}

const WRITE_TOOLS = new Set(["edit", "write", "patch", "multi_edit", "multiedit", "create_file", "apply_patch", "str_replace", "notebookedit", "notebook_edit", "search_replace"]);
const BASH_TOOLS = new Set(["bash", "shell", "exec", "run_command", "powershell", "terminal"]);
const TEST_PASS = /测试通过|全部通过|all tests? passed|tests?\s+\d+\s+pass|✓\s*\d+\s*pass|(?:#\s*)?pass\s+[1-9]\d*/i;
const TEST_FAIL = /测试失败|tests?\s+failed|failing\s+[1-9]\d*|\b[1-9]\d*\s+failed|(?:#\s*)?fail\s+[1-9]\d*\b|npm ERR/i;
const TEST_COMMAND = /\b(?:test|pytest|vitest|jest|mocha|unittest|ctest)\b|--test\b/i;

/** 有 run_start 与消息时间戳时按运行边界划窗，避免 steer 截掉本轮前半段。
 *  缺时间戳时才退回最后一条 user；不能向前猜测，否则会把上一轮产出串进来。 */
function turnWindow(messages, sinceMs) {
	const list = Array.isArray(messages) ? messages : [];
	if (Number.isFinite(sinceMs) && list.length && list.every((m) => Number.isFinite(m?.timestamp))) {
		const current = list.filter((m) => m.timestamp >= sinceMs);
		if (current.length) return current;
	}
	for (let i = list.length - 1; i >= 0; i--) { if (String(list[i]?.role || "").toLowerCase() === "user") return list.slice(i + 1); }
	return list;
}

/**
 * 快照 → 本轮产出：碰了哪些文件、多少次工具、测试结论、末句回答、下一步。
 * 字段全为可选语义（拿不到就是空），调用侧靠 filter(Boolean) 拼行。
 */
export function summarizeTurn(snap, { sinceMs } = {}) {
	const win = turnWindow(snap?.messages, sinceMs);
	const files = [];
	const seen = new Set();
	const testCalls = new Set();
	let testLine = "";
	let toolCalls = 0, writeCalls = 0, bashCalls = 0;
	let previousCall = null;
	const collectResult = (result, text, call) => {
		// read 返回的文档、助手自述不能充当测试证据。失败优先，防止同轮混合输出掩盖失败。
		if (!call?.isTest) return;
		const failed = result?.isError === true || (Number.isFinite(result?.details?.exitCode) && result.details.exitCode !== 0) || TEST_FAIL.test(text);
		if (failed) testLine = "测试失败";
		else if (testLine !== "测试失败" && TEST_PASS.test(text)) testLine = "测试通过";
	};
	for (const msg of win) {
		// 真宿主把工具结果放在独立消息；按 toolCallId 关联测试命令，不把 read 当测试。
		if (String(msg?.role || "").toLowerCase() === "toolresult") {
			collectResult(msg, blocksOf(msg).map(textOf).join("\n"), { isTest: testCalls.has(String(msg.toolCallId ?? msg.id ?? "")) });
		}
		for (const b of blocksOf(msg)) {
			if (isToolCall(b)) {
				toolCalls++;
				const name = toolNameOf(b).toLowerCase();
				const args = toolArgsOf(b);
				const p = String(args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.filename ?? args.notebook_path ?? "").trim();
				if (WRITE_TOOLS.has(name)) {
					writeCalls++;
					if (p && !seen.has(p)) { seen.add(p); files.push(p.replace(/^\.?\/+/, "").split("/").slice(-2).join("/")); }
				}
				if (BASH_TOOLS.has(name)) bashCalls++;
				previousCall = { isTest: BASH_TOOLS.has(name) && TEST_COMMAND.test(String(args.command ?? args.cmd ?? "")) };
				const callId = b.id ?? b.toolCallId ?? b.callId;
				if (previousCall.isTest && callId) testCalls.add(String(callId));
			} else if (isToolResult(b)) {
				collectResult(b, resultTextOf(b), previousCall);
			}
		}
	}
	const assistants = win.filter((m) => String(m?.role || "").toLowerCase() === "assistant");
	const lastTextRaw = assistants.length ? blocksOf(assistants[assistants.length - 1]).map(textOf).filter(Boolean).join("\n").trim() : "";
	const lastText = redactText(lastTextRaw);
	// 只从助手文本取下一步，绝不把 read/bash 的整段结果外发；句中「和下一步」不命中。
	const NEXT_RE = /(?:^|\n)\s*(?:下一步|下步|next step|待确认|需要你确认|请确认)[：: ]*([^\n]{1,80})/i;
	const next = lastText.match(NEXT_RE);
	// 仅传出测试结论，不携带工具日志正文。
	return {
		files: files.map((p) => redactText(p)), writeCalls, bashCalls, toolCalls,
		lastText: firstSentence(lastText),
		nextStep: next ? firstSentence(redactText(next[1]), 60) : "",
		testLine,
		turns: assistants.length,
	};
}

/** scm.status() 各家形状不一：尽量把分支名与脏文件数抠出来，拿不到回 null。 */
export function pickGit(st) {
	if (!st || typeof st !== "object") return null;
	const branch = String(st.branch ?? st.current ?? st.currentBranch ?? st.head ?? "").trim().replace(/^refs\/heads\//, "");
	const files = Array.isArray(st.files) ? st.files : (Array.isArray(st.changed) ? st.changed : []);
	const dirty = files.length || (st.clean === false ? 1 : 0) || Number(st.dirtyCount ?? 0) || 0;
	if (!branch && !dirty) return null;
	return { branch, dirty };
}

/**
 * 模型调 ask_user_question → 整个 agent 回合阻塞在你这边。这是比「完成」更该推的时刻，
 * 因为任务不会自己往下走。选项文字拿不到（宿主 onToolEvent 不带 args，快照里 marker 又被
 * stripMarkers 刷空，见 serialize.js:150 / markers/marker.js:95），所以只报「在等你」，
 * 点推送回 cockpit 就能看到选项。零 LLM、零额外请求。
 */
export function askNote(project) {
	return {
		kind: "ask", category: "question",
		title: clip(`⏳ ${project} · 等你回答`, SHORT_TITLE),
		body: clip("模型提了问题，会话正阻塞在你这边\n回到 cockpit 选一个就能继续", SHORT_BODY),
		sound: "campaign", level: "active", archived: false, badge: 1,
	};
}

/**
 * 事件 → 通知意图（纯函数，无 IO，可单测）。
 * @param ev 宿主 onRunEvent/onToolEvent 载荷：{type,conversationId,sessionId,clientId,runId,stopReason,at,…}
 * @param ctx {project, durationMs, convId, detail, stats, git}
 */
export function classifyEvent(ev, ctx = {}) {
	if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return null;
	const proj = ctx.project || "pi";
	const dur = fmtDur(ctx.durationMs);
	const tail = [dur && `耗时 ${dur}`, ctx.convId && `会话 ${ctx.convId}`].filter(Boolean).join(" · ");
	const detail = ctx.detail === "minimal" || ctx.detail === "rich" ? ctx.detail : "standard";
	const st = ctx.stats && typeof ctx.stats === "object" ? ctx.stats : null;
	const git = ctx.git && typeof ctx.git === "object" ? ctx.git : null;

	/** 标题：在旧文案后面追加时长与产出量（「✅ proj · 任务完成 · 1m05s · 3 文件」，SHORT_TITLE=78 字符完容得下） */
	const titleCore = (mark, what) => {
		const bits = [`${mark} ${proj} · ${what}`];
		if (detail !== "minimal") {
			if (dur) bits.push(dur);
			if (st && Array.isArray(st.files) && st.files.length) bits.push(`${st.files.length} 文件`);
		}
		return clip(bits.join(" · "), SHORT_TITLE);
	};
	/** 质量行：分支* · N 次工具 · 测试通过 */
	const qualityLine = () => {
		const bits = [];
		if (git && git.branch) bits.push(`${git.branch}${git.dirty ? "*" : ""}`);
		if (st && st.toolCalls) bits.push(`${st.toolCalls} 次工具`);
		if (st && st.testLine) bits.push(st.testLine);
		return bits.join(" · ");
	};
	/** 产出行：改了 N 个: a, b +N（standard 展 3 个，rich 展 12 个） */
	const filesLine = () => {
		const fs = st && Array.isArray(st.files) ? st.files : [];
		if (!fs.length) return "";
		const max = detail === "rich" ? 12 : 3;
		const shown = fs.slice(0, max);
		return `改了 ${fs.length} 个: ${shown.join(", ")}${fs.length > shown.length ? ` +${fs.length - shown.length}` : ""}`;
	};

	switch (ev.type) {
		// run_start 不生成通知：handleEvent 只记开始时间用于「最短运行时长」判断
		case "run_end": {
			const stop = String(ev.stopReason || "").trim().toLowerCase();
			if (FAIL_STOP.has(stop)) {
				const lines = detail === "minimal"
					? [dur && `耗时 ${dur}`, `stopReason=${stop}`, "回到 cockpit 看完整轨迹"]
					: [
						st && st.lastText ? clip(st.lastText, 110) : `stopReason=${stop}`,
						qualityLine(),
						filesLine(),
						detail === "rich" ? `耗时 ${dur || "?"} · 会话 ${ctx.convId || "?"}` : "回 cockpit 看完整轨迹",
					].filter(Boolean);
				return {
					kind: "fail", category: "interruption",
					title: titleCore("❌", `中断(${stop})`),
					body: clip(lines.join("\n"), SHORT_BODY),
					sound: "crow", level: "active", archived: false, badge: 1,
				};
			}
			if (WARN_STOP.has(stop)) {
				const lines = detail === "minimal"
					? [dur && `耗时 ${dur}`, "输出被截断或过滤，可能要续一句"]
					: [
						st && st.lastText ? clip(st.lastText, 110) : "输出被截断，可能要续一句",
						qualityLine(),
						st && st.nextStep ? `下一步: ${st.nextStep}` : "",
						`stopReason=${stop}`,
					].filter(Boolean);
				return {
					kind: "fail", category: "truncation",
					title: titleCore("⚠️", `提前收尾(${stop})`),
					body: clip(lines.join("\n"), SHORT_BODY),
					sound: "bell", level: "active", archived: false, badge: 1,
				};
			}
			const doneLines = detail === "minimal"
				? [dur || "已完成", tail && tail.replace(/ · /g, "\n")]
				: [
					st && st.lastText,
					qualityLine(),
					filesLine(),
					st && st.nextStep ? `下一步: ${st.nextStep}` : "",
					ctx.waitMs ? `中途等你 ${fmtDur(ctx.waitMs)}` : "",
					detail === "rich" ? `会话 ${ctx.convId || "?"}${st && st.turns ? ` · ${st.turns} 轮` : ""}` : "",
				].filter(Boolean);
			return {
				kind: "done", category: "completion",
				title: titleCore("✅", "任务完成"),
				body: clip(doneLines.join("\n") || (dur || "已完成"), SHORT_BODY),
				sound: "glass", level: "active", archived: false, badge: 1,
			};
		}
		case "run_error":
		case "agent_error":
			return {
				kind: "fail", category: "interruption",
				title: clip(`❌ ${proj} · 报错`, SHORT_TITLE),
				body: clip(clip(ev.error ?? ev.message ?? "未知错误", SHORT_BODY - 40) + (tail ? `\n${tail}` : ""), SHORT_BODY),
				sound: "crow", level: "active", archived: false, badge: 1,
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
		title: clip(redactText(note.title), SHORT_TITLE),
		body: clip(redactText(note.body || " "), SHORT_BODY) || " ",
		group: note.group || (note.kind === "ask" ? "pi-ask" : note.kind === "fail" ? "pi-fail" : "pi"),
		badge: Number.isFinite(note.badge) ? note.badge : 1,
		sound: note.archived ? "silence" : note.sound || "glass",
		level: levelOf(cfg, note),
		archived: Boolean(note.archived),
	};
	// 单条图标优先于设置里的 icon；两处都空就不带该字段
	const icon = String(note.iconOverride || cfg.icon || "").trim();
	if (icon) payload.icon = icon;
	if (note.url) payload.url = note.url;
	return payload;
}

/** 去重键：同标题+正文在窗口内只发一次（防故障时连环轰炸）。
 *  分类与生效级别也参与去重，避免更改级别后被旧级别吞掉。
 *  dedupSeed 用于「文案固定但语义是每次新事件」的档位——ask 提醒正文写死，
 *  不带 cid:toolCallId 的话，5 分钟窗口内第二、第三条提问会被当重复静默丢掉，
 *  而每一次提问都是「回合卡在等人」，漏报＝特性失效（同 toolCallId 由 waitingAsk 兜）。 */
export function dedupeKey(note) {
	const seed = note.dedupSeed ? `|${note.dedupSeed}` : "";
	return `${note.kind || ""}|${note.category || "manual"}|${normalizeLevel(note.level)}|${note.title}|${note.body}${seed}`;
}

export default definePlugin({
	async activate(host) {
		/** —— 运行时状态（全部内存，重启即清；配置以设置面板为准）—— */
		const startedAt = new Map();          // conversationId → run 起始 ms
		const waitingAsk = new Map();         // conversationId → {at, toolCallId}：模型提问中（回合正阻塞）
		const lastWaitMs = new Map();         // conversationId → 本轮累计等回答 ms（多次提问求和），收尾时补一行「中途等你 X」
		const sessionOf = new Map();          // conversationId → sessionId：onToolEvent 不带 sessionId（agent-service.js:4813/4851），靠 run 事件回填
		const prune = (map, cap = 200) => {
			if (map.size > cap) for (const k of [...map.keys()].slice(0, map.size - cap)) map.delete(k);
		};
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
				detail: s.detail === "minimal" || s.detail === "rich" ? s.detail : "standard", // 锁屏信息量
				askAlert: s.askAlert !== "off", // 模型提问提醒，不受 mode 限制
				levels: {
					completion: normalizeLevel(s.completionLevel),
					interruption: normalizeLevel(s.interruptionLevel),
					truncation: normalizeLevel(s.truncationLevel),
					question: normalizeLevel(s.questionLevel),
					service: normalizeLevel(s.serviceLevel),
				},
			};
		};
		/** 缺必填项 / 域名不在出站白名单：两条都让人当场看到，而不是默默不发 */
		const missingCfg = (cfg = cfgOf()) => ["server", "barkKey"].filter((k) => !String(cfg[k] || "").trim());
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
			note = { ...note, level: levelOf(cfg, note) };
			const mode = cfg.mode;
			const k = dedupeKey(note);
			const rec = (n, result, extra) => record({ kind: n.kind, category: n.category || "manual", level: n.level, title: clip(redactText(n.title), SHORT_TITLE), result, ...extra });
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
			const missing = missingCfg(cfg);
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
				// 宿主 net.fetch 回的是普通对象 {ok:true,status,text:字符串}（text 已被宿主消耗，非 Response）；被拒时回 {ok:false,error}
				const status = Number.isFinite(res?.status) ? res.status : 0;
				const text = typeof res?.text === "function" ? await res.text().catch(() => "") : String(res?.text ?? res?.error ?? res?.message ?? "");
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
			if (ev.sessionId) { sessionOf.set(cid, String(ev.sessionId)); prune(sessionOf); }
			if (ev.type === "run_start") {
				startedAt.set(cid, Number.isFinite(ev.at) ? ev.at : Date.now());
				lastWaitMs.delete(cid); // 上一轮没走到收尾（崩溃/取消）留下的等待，不串到本轮
				waitingAsk.delete(cid);
				prune(startedAt);
				return;
			}
			if (!NOTIFIABLE.has(ev.type)) return;
			// 收尾时若提问还挂着（你直接在 cockpit 回了/取消了），也结算；累加本轮全部等待时长
			let waitMs;
			{
				const w = waitingAsk.get(cid);
				if (w) { waitingAsk.delete(cid); waitMs = Math.max(0, Date.now() - w.at); }
				const lw = lastWaitMs.get(cid);
				if (lw !== undefined) { lastWaitMs.delete(cid); waitMs = waitMs === undefined ? lw : waitMs + lw; }
			}
			let durationMs;
			const sinceMs = startedAt.get(cid);
			{
				const t0 = sinceMs;
				startedAt.delete(cid);
				if (t0 !== undefined) durationMs = Math.max(0, Date.now() - t0);
			}
			let snap = null;
			try {
				snap = host.getActiveConversation({ clientId: ev.clientId }) || host.getActiveConversation();
			} catch { /* 快照拿不到就用兜底名 */ }
			const project = pickProject(snap);
			const detail = cfgOf().detail;
			let stats = null;
			let git = null;
			if (detail !== "minimal") {
				try { stats = summarizeTurn(snap, { sinceMs }); } catch { /* 摘要尽力而为 */ }
				try {
					const st = typeof host.scm?.status === "function" ? await host.scm.status() : null;
					git = pickGit(st);
				} catch { /* 非 git 工作区或被门控：没分支就少一行，不影响投递 */ }
			}
			const note = classifyEvent(ev, {
				project,
				durationMs,
				convId: shortId(cid),
				detail,
				stats,
				git,
				waitMs,
			});
			if (!note) return;
			note.group = note.kind === "fail" ? "pi-fail" : "pi";
			note.sessionId = ev.sessionId || ""; // 宿主事件自带会话 UUID → 推送直达该会话
			await notify(note, { durationMs });
		}

		/** 提问桥：toolName === ask_user_question 就是「模型在等人」的唯一插件侧信号。
		 *  start 推一次（同 toolCallId 不重推）；end 不推，只记下等了多久，留给完成通知。 */
		async function handleToolEvent(raw) {
			if (!raw || typeof raw !== "object") return;
			const ev = raw;
			const name = String(ev.toolName ?? "").trim().toLowerCase();
			if (name !== "ask_user_question" && name !== "ask_user") return;
			if (ev.phase === "start" && !cfgOf().askAlert) return;
			const cid = ev.conversationId || ev.sessionId || ev.clientId || "anon";
			if (ev.phase === "start") {
				const callId = String(ev.toolCallId ?? "");
				if (waitingAsk.get(cid)?.toolCallId === callId) return;
				waitingAsk.set(cid, { at: Date.now(), toolCallId: callId });
				prune(waitingAsk);
				let snap = null;
				try {
					snap = host.getActiveConversation({ clientId: ev.clientId }) || host.getActiveConversation();
				} catch { /* 拿快照取项目名，拿不到就兜底 */ }
				const note = askNote(pickProject(snap));
				note.group = "pi-ask";
				note.dedupSeed = `${cid}:${callId}`; // 文案固定，靠 seed 区分每一次提问
				note.sessionId = String(ev.sessionId || sessionOf.get(cid) || ""); // 点推送直达正在等人的那条会话（onToolEvent 无 sessionId → 用 run 事件回填的值）
				await notify(note, { force: true });  // 强制通道：不受 mode / 时长过滤限制
			}
			// phase === "end"：不推新通知（你都回了，再推就是打饫），只记账
			if (ev.phase === "end") {
				const w = waitingAsk.get(cid);
				if (!w || (ev.toolCallId && w.toolCallId !== String(ev.toolCallId))) return;
				waitingAsk.delete(cid);
				const ms = Number.isFinite(ev.durationMs) ? Math.max(0, Number(ev.durationMs)) : Math.max(0, Date.now() - w.at);
				lastWaitMs.set(cid, (lastWaitMs.get(cid) ?? 0) + ms); // 一轮内多次提问：求和，不是只留最后一次
				prune(lastWaitMs);
			}
		}

		// onToolEvent 载荷是 {phase,toolName,conversationId,toolCallId,durationMs?,isError?}（agent-service.js:4813/4851），
		// 没有 type 字段，不能当事件流跑；但它带 toolName，而 ask_user_question 就是「回合卡在等人」的唯一信号。
		const offRun = host.onRunEvent((ev) => { handleEvent(ev).catch((err) => host.log("error", String(err?.message || err))); });
		const offAsk = typeof host.onToolEvent === "function"
			? host.onToolEvent((raw) => { handleToolEvent(raw).catch((err) => host.log("warn", `提问事件处理失败：${String(err?.message ?? err)}`)); })
			: null;

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
		// scm 要 fs/fs:read（plugins.js:3996-4003 未声明即抛错）：分支行靠它，必须探，否则 /ping 报 9/9 而分支恒缺
		probe("scm", () => (typeof host.scm?.status === "function" ? "ok" : "missing（宿主无 scm，分支行不会出现）"));
		const capsBlocked = Object.entries(caps).filter(([, v]) => v !== "ok");

		/** —— 外部/手机回环 HTTP（挂在 /plugins-api/bark-notify/*）—— */
		host.route("GET", "/ping", (_req, res) => sendJson(res, 200, { ok: true, id: "bark-notify", configured: missingCfg().length === 0, missing: missingCfg(), allowlistHint: allowHint(cfgOf().server) || null, mode: curMode(), hasKey: Boolean(cfgOf().barkKey), server: cfgOf().server || null, webBase: cfgOf().webBase || null, netAllowlist: [...ALLOWED_HOSTS, ...netGranted], levels: cfgOf().levels, permissions: ["net", "fs:read", "secrets", "storage", "ui", "http", "tools", "notify", "chat"], capabilities: caps, blocked: capsBlocked }));
		host.route("GET", "/status", (_req, res) => sendJson(res, 200, { ok: true, mode: curMode(), recent, icon: cfgOf().icon || null, hasKey: Boolean(cfgOf().barkKey), configured: missingCfg().length === 0, missing: missingCfg(), allowlistHint: allowHint(cfgOf().server) || null }));
		host.route("POST", "/test", async (req, res) => {
			const contentType = String(req?.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
			if (contentType !== "application/json") return sendJson(res, 415, { ok: false, error: "application/json required" });
			const out = await notify({ kind: "done", category: "service", title: "Bark 推送测试", body: "配置测试通知", sound: "glass", level: "active", badge: 1 },
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
			description: "给用户手机推一条 Bark 通知。适合：长任务完成、需要用户在手机上决策、跑挂了。level 可选普通/时效性/关键通知，默认 active；critical 在用户授权后可穿透静音/专注模式。",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "锁屏第一行，建议带状态 emoji，≤40 字" },
					body: { type: "string", description: "关键数字/下一步动作，可用 \\n 换行" },
					level: { type: "string", enum: ["active", "timeSensitive", "critical"], description: "默认 active 普通；timeSensitive 时效性；critical 关键通知/静音穿透（需系统授权）；quiet 优先" },
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
					kind: "done",
					title: clip(p.title || "🔔 推送", SHORT_TITLE),
					body: clip(p.body || "", SHORT_BODY),
					sound: p.quiet ? "silence" : p.sound || "glass",
					level: normalizeLevel(p.level),
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
				kind: capsBlocked.length ? "ask" : "done", category: "service",
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
			for (const off of [offRun, offAsk, offToolReg, offSettings]) { try { off?.(); } catch {} }
		};
	},
});
