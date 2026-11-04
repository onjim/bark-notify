/**
 * bark-notify 单测：`node --test index.test.mjs`
 * 用 SDK 自带 createMockHost，不需要起宿主服务。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import plugin, { classifyEvent, buildPayload, dedupeKey, pickProject, numSet, summarizeTurn, pickGit, firstSentence, askNote } from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";

describe("classifyEvent", () => {
	it("正常收尾 → done + glass", () => {
		const note = classifyEvent({ type: "run_end", stopReason: "end_turn" }, { project: "pi-web-ui", durationMs: 65_000, convId: "abcd1234" });
		assert.equal(note.kind, "done");
		assert.match(note.title, /✅ pi-web-ui · 任务完成/);
		assert.match(note.body, /1m05s/);
		assert.equal(note.sound, "glass");
		assert.equal(note.level, "active");
	});

	it("error 收尾 → fail + critical（穿透静音）", () => {
		const note = classifyEvent({ type: "run_end", stopReason: "error" }, { project: "api" });
		assert.equal(note.kind, "fail");
		assert.equal(note.level, "critical");
		assert.equal(note.sound, "crow");
	});

	it("截断收尾 → warn 级 timeSensitive", () => {
		const note = classifyEvent({ type: "run_end", stopReason: "length" }, {});
		assert.equal(note.kind, "fail");
		assert.equal(note.level, "timeSensitive");
	});

	it("噪声事件一律不推（防刷屏）", () => {
		for (const type of ["turn_end", "turn_start", "tool_delta", "tool_info", "run_start", "tool_approval_pending", "question_pending", "unknown_kind"]) {
			assert.equal(classifyEvent({ type }, {}), null, type);
		}
		assert.equal(classifyEvent(null, {}), null);
	});

	it("标题超长会被裁掉", () => {
		const note = classifyEvent({ type: "run_end" }, { project: "x".repeat(200) });
		assert.ok(note.title.length <= 79, `title=${note.title.length}`);
	});
});

describe("buildPayload", () => {
	it("缺 key 直接不构造（避免白跑一趟 HTTP）", () => {
		assert.equal(buildPayload({ barkKey: "" }, { title: "t", body: "b", kind: "done" }), null);
	});

	it("必须是 snake_case device_key + 分级字段", () => {
		const p = buildPayload(
			{ barkKey: "K1", icon: "https://x/i.png" },
			{ kind: "ask", title: "🙋 等批准", body: "rm -rf", sound: "cicada", level: "timeSensitive", badge: 1, url: "https://cockpit/ack" },
		);
		assert.equal(p.device_key, "K1");
		assert.equal(p.level, "timeSensitive");
		assert.equal(p.sound, "cicada");
		assert.equal(p.icon, "https://x/i.png");
		assert.equal(p.url, "https://cockpit/ack");
		assert.equal(p.title, "🙋 等批准"); // emoji 原样，不做 URL 编码
	});

	it("静默归档：archived=true 且 badge=0", () => {
		const p = buildPayload({ barkKey: "K1" }, { kind: "done", title: "⏳", body: "", sound: "silence", archived: true, badge: 0 });
		assert.equal(p.archived, true);
		assert.equal(p.badge, 0);
	});

	it("同内容去重键稳定，不同内容不同", () => {
		const a = { kind: "done", title: "A", body: "B" };
		assert.equal(dedupeKey(a), dedupeKey({ ...a }));
		assert.notEqual(dedupeKey(a), dedupeKey({ ...a, body: "C" }));
	});
});

describe("activate（mock host）", () => {
	const settings = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "all", minRunMinutes: 0, dedupSec: 0, icon: "https://x/i.png" };

	const requestTest = (host, headers = { "content-type": "application/json" }) => new Promise((resolve) => {
		const route = host.mock.routes.find((r) => (r.path || r[1]) === "/test");
		(route?.handler || route?.[2])({ headers }, { writeHead: (status) => { resolve.status = status; }, end: (body) => resolve({ status: resolve.status, body: JSON.parse(body) }) });
	});

	it("只提供原生设置，状态使用配置档位且不注册测试命令", async () => {
		const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
		assert.equal(manifest.view, false);
		assert.ok(!manifest.ui?.settings);
		const host = createMockHost({ settings });
		host.storage.set("mode", "silent");
		await plugin.activate(host);
		const route = host.mock.routes.find((r) => (r.path || r[1]) === "/status");
		let body;
		(route?.handler || route?.[2])?.({}, { writeHead: () => {}, end: (s) => { body = s; } });
		assert.equal(JSON.parse(body).hasKey, true);
		assert.equal(JSON.parse(body).mode, "all");
		assert.equal(host.mock.calls("registerCommand").length, 0);
	});

	it("注册 HTTP 端点 / AI 工具 / 事件订阅", async () => {
		const host = createMockHost({ settings });
		await plugin.activate(host);
		const calls = host.mock.calls();
		assert.ok(calls.some((c) => c.method === "onRunEvent"), "应订阅 run 事件");
		assert.ok(
			calls.some((c) => c.method === "registerAgentTool" || c.method === "registerTool"),
			"应注册 bark_notify 工具（真宿主走 registerAgentTool）",
		);
		const routes = calls.filter((c) => c.method === "route").map((c) => c.args[1]);
		for (const p of ["/ping", "/status", "/send"]) assert.ok(routes.includes(p), `缺路由 ${p}`);
	});

	it("不限时长时完成事件真投递到 /push", async () => {
		const host = createMockHost({ settings });
		const fetches = [];
		host.net.fetch = async (url, init) => {
			fetches.push({ url, init });
			return { status: 200, text: async () => '{"code":200,"message":"success"}' };
		};
		host.storage.set("boot:lastPing", Date.now()); // 胉眼：跳过上线回执，只看事件投递
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "conv-1", clientId: "c1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1, "应发一次 HTTP");
		assert.match(fetches[0].url, /^https:\/\/example\.com\/push$/);
		const body = JSON.parse(fetches[0].init.body);
		assert.equal(body.device_key, "MOCK");
		assert.match(body.title, /✅ pi · 任务完成/);
	});

	it("旧版残留 silent 值降级为只推出错：完成不推、出错照推", async () => {
		const host = createMockHost({ settings: { ...settings, mode: "silent" } });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "old-silent-done", at: Date.now() });
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "old-silent-fail", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1, "完成不应推，出错应推");
		assert.match(JSON.parse(fetches[0].init.body).title, /中断/);
	});

	it("首次加载会推一条上线回执（含能力自检结果）", async () => {
		const host = createMockHost({ settings });
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1, "应有一条上线回执");
		const body = JSON.parse(fetches[0].init.body);
		assert.match(body.title, /🔌 bark-notify 已加载/);
		assert.match(body.body, /能力 \d+\/\d+ 可用/);
	});

	it("10 分钟内重复加载不重复推上线回执", async () => {
		const host = createMockHost({ settings });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 0);
	});

	it("缺 Bark 服务器或密钥 → 不发出，并点名缺哪项", async () => {
		for (const miss of ["server", "barkKey"]) {
			const host = createMockHost({ settings: { ...settings, [miss]: "" } });
			const fetches = [];
			host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
			await plugin.activate(host);
			host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: `c-${miss}`, at: Date.now() });
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(fetches.length, 0, `${miss} 缺失时不该发 HTTP`);
			const ping = host.mock.routes.find((r) => (r.path || r[1]) === "/ping");
			let body = "";
			(ping?.handler || ping?.[2])?.({}, { writeHead: () => {}, end: (s) => { body = s; } });
			const out = JSON.parse(body);
			assert.equal(out.configured, false, `${miss} 缺失应报 configured:false`);
			assert.ok(out.missing.includes(miss), `missing 应包含 ${miss}`);
		}
	});

	it("外网地址可选：留空照常推送，有地址时附跳转链接", async () => {
		for (const webBase of ["", "https://cockpit.test"]) {
			const host = createMockHost({ settings: { ...settings, webBase } });
			host.storage.set("boot:lastPing", Date.now());
			const fetches = [];
			host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
			await plugin.activate(host);
			host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "optional-url", at: Date.now() });
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(fetches.length, 1);
			const payload = JSON.parse(fetches[0].init.body);
			if (webBase) assert.equal(payload.url, `${webBase}/`);
			else assert.equal("url" in payload, false);
			const ping = host.mock.routes.find((r) => (r.path || r[1]) === "/ping");
			let body = "";
			(ping?.handler || ping?.[2])?.({}, { writeHead: () => {}, end: (s) => { body = s; } });
			assert.equal(JSON.parse(body).configured, true);
		}
	});

	it("自架域名未获授权 → 申请一次，仍拒则当场点名", () => {
		const host = createMockHost({ settings: { ...settings, server: "https://bark.myown.net" } });
		return plugin.activate(host).then(async () => {
			const asked = host.mock.calls("requestPermission");
			assert.equal(asked.length, 1, "activate 应就该主机申请一次出站授权");
			assert.deepEqual(asked[0].args[0].hosts, ["bark.myown.net"]);
			const ping = host.mock.routes.find((r) => (r.path || r[1]) === "/ping");
			let body = "";
			(ping?.handler || ping?.[2])?.({}, { writeHead: () => {}, end: (s) => { body = s; } });
			const out = JSON.parse(body);
			assert.match(String(out.allowlistHint), /bark\.myown\.net/);
			assert.match(String(out.allowlistHint), /netAllowlist/);
		});
	});

	it("用户批准自架域名 → 放行，且不再重复弹框", async () => {
		const host = createMockHost({
			settings: { ...settings, server: "https://bark.myown.net" },
			requestPermission: async () => true,
		});
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(fetches.length >= 1, "批准后应能真的发出去");
		assert.equal(fetches[0].url, "https://bark.myown.net/push");
		const before = host.mock.calls("requestPermission").length;
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "conv-granted", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(host.mock.calls("requestPermission").length, before, "已批过的主机不该再弹框");
	});

	it("默认 api.day.app 无需申请授权", async () => {
		const host = createMockHost({ settings: { ...settings, server: "https://api.day.app" } });
		host.net.fetch = async () => ({ status: 200, text: async () => '{"code":200}' });
		await plugin.activate(host);
		assert.equal(host.mock.calls("requestPermission").length, 0);
	});

	it("完成通知只在同一运行超过五分钟后发送，开始与未知时长不推", async (t) => {
		let now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const host = createMockHost({ settings: { ...settings, minRunMinutes: 5 } });
		host.storage.set("boot:lastPing", now);
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "short" });
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "long" });
		await new Promise((r) => setImmediate(r));
		assert.equal(fetches.length, 0, "开始不应发送");
		now += 300000;
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "short", stopReason: "end_turn" });
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "unknown", stopReason: "end_turn" });
		await new Promise((r) => setImmediate(r));
		assert.equal(fetches.length, 0, "恰好五分钟和未知时长不应发送");
		now += 1;
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "long", stopReason: "end_turn" });
		await new Promise((r) => setImmediate(r));
		assert.equal(fetches.length, 1, "超过五分钟应发送一次完成通知");
		assert.match(JSON.parse(fetches[0].init.body).title, /任务完成/);
	});

	it("短运行的错误仍立即推送", async () => {
		const host = createMockHost({ settings: { ...settings, minRunMinutes: 5 } });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "failed" });
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "failed", stopReason: "error" });
		await new Promise((r) => setImmediate(r));
		assert.equal(fetches.length, 1);
		assert.match(JSON.parse(fetches[0].init.body).title, /中断/);
	});

	it("未配置时只报本来真要发的事件：短完成静默丢弃，出错才报缺配置", async (t) => {
		let now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const empty = { mode: "all", minRunMinutes: 5, dedupSec: 0 };
		const host = createMockHost({ settings: { ...empty } });
		host.storage.set("boot:lastPing", now);
		await plugin.activate(host);
		const warnAt = host.mock.calls("notify").filter((c) => c.args[0] === "warning").length;
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "fast" });
		now += 300000;
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "fast", stopReason: "end_turn" });
		await new Promise((r) => setImmediate(r));
		assert.equal(host.mock.calls("notify").filter((c) => c.args[0] === "warning").length, warnAt, "被时长过滤的完成不该报未配置");
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "boom" });
		host.mock.emit("onRunEvent", { type: "run_end", conversationId: "boom", stopReason: "error" });
		await new Promise((r) => setImmediate(r));
		assert.ok(host.mock.calls("notify").filter((c) => c.args[0] === "warning").length > warnAt, "真要发的出错应报缺配置");
	});

	it("保存新域名立即申请授权；修改密钥不重新申请", async () => {
		const host = createMockHost({ settings: { ...settings }, requestPermission: async () => false });
		host.storage.set("boot:lastPing", Date.now());
		await plugin.activate(host);
		host.mock.emitSettings({ server: "https://new.example.net" });
		await new Promise((r) => setImmediate(r));
		assert.equal(host.mock.calls("requestPermission").length, 1);
		host.mock.emitSettings({ barkKey: "changed" });
		await new Promise((r) => setImmediate(r));
		assert.equal(host.mock.calls("requestPermission").length, 1);
		assert.ok(host.mock.calls("notify").some((c) => c.args[0] === "warning"));
	});

	it("保存配置后下一次推送使用新设置", async () => {
		const host = createMockHost({ settings: { ...settings } });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.secrets.set("setting:barkKey", "NEW_KEY");
		host.mock.emitSettings({ server: "https://api.day.app", webBase: "", mode: "all", icon: "https://example.com/new.png" });
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "updated", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1);
		assert.equal(fetches[0].url, "https://api.day.app/push");
		const payload = JSON.parse(fetches[0].init.body);
		assert.equal(payload.device_key, "NEW_KEY");
		assert.equal(payload.icon, "https://example.com/new.png");
		assert.equal("url" in payload, false);
	});

	it("手动测试可重试拒绝的授权，不泄露返回正文并绕过去重", async () => {
		let granted = false;
		const host = createMockHost({ settings: { ...settings, server: "https://new.example.net", mode: "important", dedupSec: 300 }, requestPermission: async () => granted });
		host.storage.set("boot:lastPing", Date.now());
		let sent = 0;
		host.net.fetch = async () => { sent++; return { status: 200, text: async () => '{"code":200,"secret":"DO_NOT_RETURN"}' }; };
		await plugin.activate(host);
		assert.equal((await requestTest(host, {})).status, 415);
		granted = true;
		for (let i = 0; i < 2; i++) {
			const result = await requestTest(host);
			assert.equal(result.status, 200);
			assert.deepEqual(result.body, { ok: true, status: 200 });
		}
		assert.equal(sent, 2);
	});

	it("并发请求共用授权；授权期间配置变更时不发旧配置", async () => {
		let resolveGrant;
		const host = createMockHost({ settings: { ...settings }, requestPermission: () => new Promise((resolve) => { resolveGrant = resolve; }) });
		host.storage.set("boot:lastPing", Date.now());
		let sent = 0;
		host.net.fetch = async () => { sent++; return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emitSettings({ server: "https://new.example.net" });
		const first = requestTest(host);
		const second = requestTest(host);
		assert.equal(host.mock.calls("requestPermission").length, 1);
		host.mock.emitSettings({ server: "https://example.com" });
		resolveGrant(true);
		assert.equal((await first).body.reason, "configuration-changed");
		assert.equal((await second).body.reason, "configuration-changed");
		assert.equal(sent, 0);
	});

describe("图标", () => {
	it("单条 iconOverride 优先于设置里的 icon", () => {
		const p = buildPayload({ barkKey: "K1", icon: "https://cfg/i.png" }, { kind: "done", title: "t", body: "b", iconOverride: "https://shot/a.png" });
		assert.equal(p.icon, "https://shot/a.png");
	});

	it("两处都空 → payload 不带 icon 字段（走 App 默认图标）", () => {
		const p = buildPayload({ barkKey: "K1", icon: "" }, { kind: "done", title: "t", body: "b" });
		assert.equal("icon" in p, false);
	});

});

describe("项目名提取", () => {
	it("cwd basename 优先", () => {
		assert.equal(pickProject({ cwd: "/home/dev/repos/pi-web-ui", title: "随便什么" }), "pi-web-ui");
	});

	it("标题是 URL 时不能拿它当项目名（锁屏会变成长链）", () => {
		assert.equal(pickProject({ cwd: "", title: "https://bark.day.app/#/params?id=%e8%af%b7%e6%b1%82" }), "pi");
	});

	it("超长标题也回落", () => {
		assert.equal(pickProject({ cwd: "", title: "x".repeat(31) }), "pi");
		assert.equal(pickProject({}), "pi");
		assert.equal(pickProject(null), "pi");
	});

	it("端到端：标题为 URL 的会话，推送标题里不出现链", async () => {
		const host = createMockHost({ settings });
		host.storage.set("boot:lastPing", Date.now());
		host.getActiveConversation = () => ({ cwd: "", title: "https://bark.day.app/#/params?id=x" });
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "c-url", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1);
		const body = JSON.parse(fetches[0].init.body);
		assert.equal(body.title, "✅ pi · 任务完成");
		assert.equal(/https?:/.test(body.title), false);
	});
});

describe("numSet 与失败重试（review 补盖）", () => {
	it("数字设置：空串/非法回默认，0 = 显式不限", () => {
		assert.equal(numSet("", 300), 300);
		assert.equal(numSet("  ", 300), 300);
		assert.equal(numSet("abc", 300), 300);
		assert.equal(numSet("0", 300), 0);
		assert.equal(numSet("60", 300), 60);
	});

	it("投递失败释放去重标记：同内容可重试；成功送达才占窗口", async () => {
		const s = { server: "https://example.com", barkKey: "MOCK", webBase: "", mode: "all", minRunMinutes: 0, dedupSec: 300, icon: "" };
		const host = createMockHost({ settings: s });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		let gatewayDown = true;
		host.net.fetch = async (url, init) => {
			fetches.push({ url, init });
			return gatewayDown
				? { status: 500, text: async () => "gateway hiccup" }
				: { status: 200, text: async () => '{"code":200}' };
		};
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "retry-1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1, "首次尝试应发出（随后 500）");
		gatewayDown = false;
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "retry-1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 2, "失败已释放去重标记，同事件应重试");
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "retry-1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 2, "成功送达后同内容应被去重");
	});

	it("授权弹框挂住不拖 activate：boot 不再阻塞路由/事件接入", async () => {
		const s = { server: "https://bark.mine.test", barkKey: "MOCK", webBase: "", mode: "all", minRunMinutes: 0, dedupSec: 300, icon: "" };
		const host = createMockHost({ settings: s, requestPermission: () => new Promise(() => {}) }); // 永不回：模拟用户不在 120s 内点
		const t0 = Date.now();
		await plugin.activate(host);
		assert.ok(Date.now() - t0 < 50, "activate 应立即完成，不等授权结果");
	});

	it("事件推送自动附 #s=<会话UUID>；无 sessionId 时回落根路径", async () => {
		const s = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "all", minRunMinutes: 0, dedupSec: 0, icon: "" };
		const host = createMockHost({ settings: s });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "c1", sessionId: "01a18aa8-f143-7209-b1bb-2e84cfe8119e", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1);
		assert.equal(JSON.parse(fetches[0].init.body).url, "https://cockpit.test/#s=01a18aa8-f143-7209-b1bb-2e84cfe8119e");
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "c2", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(JSON.parse(fetches[1].init.body).url, "https://cockpit.test/");
	});

	it("外部 /send 可选 session：url 附 #s=，非法字符被洗", async () => {
		const s = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "all", minRunMinutes: 0, dedupSec: 0, icon: "" };
		const host = createMockHost({ settings: s });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		const route = host.mock.routes.find((r) => r.method === "POST" && r.path === "/send");
		await route.handler({ body: { title: "t1", session: "abcd-1234" } }, { writeHead: () => {}, end: () => {} });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(JSON.parse(fetches[0].init.body).url, "https://cockpit.test/#s=abcd-1234");
		await route.handler({ body: { title: "t2", session: "x/../<script>" } }, { writeHead: () => {}, end: () => {} });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(JSON.parse(fetches[1].init.body).url, "https://cockpit.test/#s=xscript");
	});

	it("宿主 net.fetch 真实形状（{ok,status,text:字符串}）判为 sent 而非 http-200", async () => {
		const s = { server: "https://example.com", barkKey: "MOCK", webBase: "", mode: "all", minRunMinutes: 0, dedupSec: 0, icon: "" };
		const host = createMockHost({ settings: s });
		host.storage.set("boot:lastPing", Date.now());
		let hits = 0;
		// 真宿主 pluginNetFetch：返回普通对象，text 已是字符串（无 .text() 方法）
		host.net.fetch = async () => { hits++; return { ok: true, status: 200, text: '{"code":200,"message":"success","timestamp":1}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "shape-1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(hits, 1);
		const statusRoute = host.mock.routes.find((r) => r.path === "/status");
		let body;
		statusRoute.handler({}, { writeHead: () => {}, end: (s2) => { body = s2; } });
		const recent = JSON.parse(body).recent.filter((r) => r.title && /中断/.test(r.title));
		assert.equal(recent[0].result, "sent", "普通对象响应应被判 sent（回归：旧写法 text 丢空误判 http-200）");
	});
});
});

describe("锁屏信息量（detail 三档）", () => {
	const settings = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "all", minRunMinutes: 0, dedupSec: 0, icon: "", detail: "standard" };
	const snap = {
		cwd: "/home/dev/repos/app",
		messages: [
			{ role: "user", content: [{ type: "text", text: "把登录改成 SSO" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "先看看现状" },
					{ type: "toolCall", name: "read", input: { path: "/home/dev/repos/app/src/auth.ts" } },
					{ type: "toolResult", content: [{ type: "text", text: "export function login…" }] },
					{ type: "toolCall", name: "edit", input: { path: "/home/dev/repos/app/src/auth.ts" } },
					{ type: "toolCall", name: "bash", input: { command: "npm test" } },
					{ type: "toolResult", content: [{ type: "text", text: "Tests 12 passed" }] },
					{ type: "toolCall", name: "write", input: { file_path: "/home/dev/repos/app/src/sso.ts" } },
					{ type: "text", text: "已把登录改为 SSO，并接好回调。\n\n下一步：请在测试环境验证回调域名。" },
				],
			},
		],
	};
	const stats = summarizeTurn(snap);
	const base = { project: "app", durationMs: 65_000, convId: "abcd1234" };

	it("从快照抠出：文件清单 / 工具数 / 测试结论 / 首句 / 下一步", () => {
		assert.deepEqual(stats.files, ["src/auth.ts", "src/sso.ts"]); // 去重 + 只留末两级
		assert.equal(stats.toolCalls, 4);
		assert.equal(stats.bashCalls, 1);
		assert.equal(stats.testLine, "测试通过");
		assert.match(stats.lastText, /已把登录改为 SSO/);
		assert.match(stats.nextStep, /测试环境验证回调域名/);
	});

	it("句中的「下一步」不会被误抓（只认行首）", () => {
		const s = summarizeTurn({
			cwd: "/home/dev/repos/app",
			messages: [
				{ role: "user", content: [{ type: "text", text: "改完了吗" }] },
				{ role: "assistant", content: [{ type: "text", text: "我会把改动做完，和下一步计划一起给你。" }] },
			],
		});
		assert.equal(s.nextStep, "");
		const t = summarizeTurn({
			cwd: "/home/dev/repos/app",
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{ role: "assistant", content: [{ type: "text", text: "改造完成，风险可控。\n下一步：刷新浏览器让新版接管。" }] },
			],
		});
		assert.equal(t.nextStep, "刷新浏览器让新版接管。");
	});

	it("minimal 档 = 旧文案，不夹带摘要", () => {
		const n = classifyEvent({ type: "run_end", stopReason: "end_turn" }, { ...base, detail: "minimal" });
		assert.equal(n.title, "✅ app · 任务完成");
		assert.match(n.body, /耗时 1m05s/);
		assert.equal(n.body.includes("改了"), false);
	});

	it("standard 档：标题带时长与文件数，正文四行（摘要/质量/产出/下一步）", () => {
		const n = classifyEvent({ type: "run_end", stopReason: "end_turn" }, { ...base, detail: "standard", stats, git: { branch: "main", dirty: 2 } });
		assert.equal(n.title, "✅ app · 任务完成 · 1m05s · 2 文件");
		const lines = n.body.split("\n");
		assert.equal(lines.length, 4);
		assert.match(lines[0], /已把登录改为 SSO/);
		assert.match(lines[1], /main\* · 4 次工具 · 测试通过/);
		assert.match(lines[2], /改了 2 个: src\/auth\.ts, src\/sso\.ts/);
		assert.match(lines[3], /下一步:.*测试环境验证回调域名/);
	});

	it("rich 档多一行会话与轮次，干净分支不带 *", () => {
		const n = classifyEvent({ type: "run_end", stopReason: "end_turn" }, { ...base, detail: "rich", stats, git: { branch: "main", dirty: 0 } });
		assert.match(n.body, /main · 4 次工具/);
		assert.match(n.body, /会话 abcd1234 · 1 轮/);
	});

	it("出错时 critical 不变，standard 把摘要与产出排上去", () => {
		const n = classifyEvent({ type: "run_end", stopReason: "error" }, { ...base, durationMs: 9000, detail: "standard", stats, git: { branch: "fix", dirty: 1 } });
		assert.equal(n.level, "critical");
		assert.equal(n.title, "❌ app · 中断(error) · 9s · 2 文件");
		assert.match(n.body, /fix\* · 4 次工具 · 测试通过/);
	});

	it("没快照 / 没 git → 优雅降级（少行，不缺字段，不抛）", () => {
		const n = classifyEvent({ type: "run_end", stopReason: "end_turn" }, { project: "app", durationMs: 1000, convId: "zz", detail: "standard" });
		assert.equal(n.title, "✅ app · 任务完成 · 1s");
		assert.ok(n.body.length > 0);
	});

	it("pickGit 容忍各家形状，拿不到回 null", () => {
		assert.deepEqual(pickGit({ branch: "refs/heads/main", files: [1, 2] }), { branch: "main", dirty: 2 });
		assert.deepEqual(pickGit({ current: "dev", clean: false }), { branch: "dev", dirty: 1 });
		assert.equal(pickGit({ ok: false, error: "not a git repo" }), null);
		assert.equal(pickGit(null), null);
	});

	it("firstSentence 按中英文标点切并限长", () => {
		assert.equal(firstSentence("第一句。第二句。"), "第一句。");
		assert.equal(firstSentence("one two. three", 8), "one two.");
		assert.equal(firstSentence("   "), "");
	});

	it("端到端：standard 档 + 真快照 + scm.status → 推送里带分支与文件数", async () => {
		const host = createMockHost({ settings: { ...settings, detail: "standard", minRunMinutes: 0 } });
		host.storage.set("boot:lastPing", Date.now());
		host.getActiveConversation = () => snap;
		host.scm = { status: async () => ({ branch: "refs/heads/main", files: [1, 2, 3] }) };
		const fetches = [];
		host.net.fetch = async (url, init) => { fetches.push(JSON.parse(init.body)); return { ok: true, status: 200, text: '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "c1", sessionId: "s1", at: Date.now() });
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(fetches.length, 1);
		assert.match(fetches[0].title, /· 2 文件/);
		assert.match(fetches[0].body, /main\* · 4 次工具 · 测试通过/);
		assert.match(fetches[0].body, /改了 2 个: src\/auth\.ts, src\/sso\.ts/);
	});
});

describe("等回答提醒（ask_user_question → 回合阻塞）", () => {
	const settings = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "important", minRunMinutes: 5, dedupSec: 0, icon: "", askAlert: "on" };
	const snap = { cwd: "/home/dev/repos/app", messages: [{ role: "user", content: [{ type: "text", text: "选个方案" }] }, { role: "assistant", content: [{ type: "text", text: "有两个路子：A 稳，B 快。" }] }] };
	const nap = (ms) => new Promise((r) => setTimeout(r, ms));

	function boot(over = {}) {
		const host = createMockHost({ settings: { ...settings, ...over.settings } });
		host.storage.set("boot:lastPing", Date.now());
		host.requestPermission = async () => true;
		host.getActiveConversation = () => snap;
		const got = [];
		host.net.fetch = async (url, init) => { got.push(JSON.parse(init.body)); return { ok: true, status: 200, text: '{"code":200}' }; };
		return { host, got };
	}

	it("askNote：critical + campaign，文案说清在等你", () => {
		const n = askNote("app");
		assert.equal(n.kind, "ask");
		assert.equal(n.level, "critical");
		assert.equal(n.sound, "campaign");
		assert.equal(n.title, "⏳ app · 等你回答");
	});

	it("提问一到就推，important 档也拦不住（force 通道）", async () => {
		const { host, got } = boot();
		await plugin.activate(host);
		host.mock.emit("onToolEvent", { phase: "start", toolName: "ask_user_question", conversationId: "c1", sessionId: "s1", toolCallId: "t1" });
		await nap(80);
		assert.equal(got.length, 1);
		assert.equal(got[0].title, "⏳ app · 等你回答");
		assert.equal(got[0].sound, "campaign");
		assert.equal(got[0].group, "pi-ask");
		assert.match(got[0].url, /#s=s1/);
	});

	it("同一 toolCallId 重放不重推", async () => {
		const { host, got } = boot();
		await plugin.activate(host);
		const ev = { phase: "start", toolName: "ask_user_question", conversationId: "c1", toolCallId: "t1" };
		host.mock.emit("onToolEvent", ev);
		host.mock.emit("onToolEvent", ev);
		await nap(80);
		assert.equal(got.length, 1);
	});

	it("回答后不补发；完成通知里出现「中途等你 X」", async () => {
		const { host, got } = boot({ settings: { mode: "all", minRunMinutes: 0 } });
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_start", conversationId: "c1", sessionId: "s1" });
		host.mock.emit("onToolEvent", { phase: "start", toolName: "ask_user_question", conversationId: "c1", sessionId: "s1", toolCallId: "t1" });
		await nap(60);
		host.mock.emit("onToolEvent", { phase: "end", toolName: "ask_user_question", conversationId: "c1", sessionId: "s1", toolCallId: "t1", durationMs: 8000, isError: false });
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "c1", sessionId: "s1", at: Date.now() });
		await nap(150);
		assert.equal(got.length, 2, "一条提问 + 一条完成，中间不插墓");
		assert.match(got[0].title, /等你回答/);
		assert.match(got[1].title, /任务完成/);
		assert.match(got[1].body, /中途等你 8s/);
	});

	it("askAlert=off 就安静；非提问工具与垃圾载荷不推不抛", async () => {
		const a = boot({ settings: { askAlert: "off" } });
		await plugin.activate(a.host);
		a.host.mock.emit("onToolEvent", { phase: "start", toolName: "ask_user_question", conversationId: "c9", toolCallId: "t9" });
		const b = boot();
		await plugin.activate(b.host);
		b.host.mock.emit("onToolEvent", { phase: "start", toolName: "bash", conversationId: "c9", toolCallId: "t9" });
		b.host.mock.emit("onToolEvent", null);
		b.host.mock.emit("onToolEvent", { phase: "start" });
		await nap(100);
		assert.equal(a.got.length, 0);
		assert.equal(b.got.length, 0);
	});
});
