/**
 * bark-notify 单测：`node --test index.test.mjs`
 * 用 SDK 自带 createMockHost，不需要起宿主服务。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin, { classifyEvent, buildPayload, dedupeKey, pickProject } from "./index.mjs";
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

	it("等批准 → ask 且带 ack 回环", () => {
		const note = classifyEvent({ type: "tool_approval_pending", command: "rm -rf dist", conversationId: "conv-9999ff00" }, { project: "web" });
		assert.equal(note.kind, "ask");
		assert.match(note.title, /🙋 等批准 · web/);
		assert.match(note.body, /rm -rf dist/);
		assert.ok(note.ack);
	});

	it("噪声事件一律不推（防刷屏）", () => {
		for (const type of ["turn_end", "turn_start", "tool_delta", "tool_info", "unknown_kind"]) {
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
		const p = buildPayload({ barkKey: "K1" }, { kind: "start", title: "⏳", body: "", sound: "silence", archived: true, badge: 0 });
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
	const settings = { server: "https://example.com", barkKey: "MOCK", webBase: "https://cockpit.test", mode: "all", muteWhenActive: 0, minRunMs: 0, dedupSec: 0, icon: "https://x/i.png", morningCron: "" };

	it("注册 UI 档位 / HTTP 端点 / AI 工具 / 事件订阅", async () => {
		const host = createMockHost({ settings });
		await plugin.activate(host);
		const calls = host.mock.calls();
		assert.ok(calls.some((c) => c.method === "ui.register"), "应注册 composer 档位");
		assert.ok(calls.some((c) => c.method === "onRunEvent"), "应订阅 run 事件");
		assert.ok(
			calls.some((c) => c.method === "registerAgentTool" || c.method === "registerTool"),
			"应注册 bark_notify 工具（真宿主走 registerAgentTool）",
		);
		const routes = calls.filter((c) => c.method === "route").map((c) => c.args[1]);
		for (const p of ["/ping", "/status", "/send", "/ack"]) assert.ok(routes.includes(p), `缺路由 ${p}`);
	});

	it("前台活跃窗口=0 时事件会真投递到 /push", async () => {
		const host = createMockHost({ settings });
		const fetches = [];
		host.fetch = async (url, init) => {
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

	it("silent 档位一律不外发", async () => {
		const host = createMockHost({ settings: { ...settings, mode: "silent" } });
		host.storage.set("boot:lastPing", Date.now()); // 胉眼：上线回执是 force 推送，会绕过 silent
		const fetches = [];
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "error", conversationId: "conv-2", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 0);
	});

	it("morningCron 非空则挂定时任务", async () => {
		const host = createMockHost({ settings: { ...settings, morningCron: "0 8 * * *" } });
		await plugin.activate(host);
		assert.ok(host.mock.schedules.length >= 1, "应挂上晨报定时任务");
	});

	it("首次加载会推一条上线回执（含能力自检结果）", async () => {
		const host = createMockHost({ settings });
		const fetches = [];
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
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
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 0);
	});

	it("缺 Bark 服务器 / 密钥 / 外网地址 → 不发出，并点名缺哪项", async () => {
		for (const miss of ["server", "barkKey", "webBase"]) {
			const host = createMockHost({ settings: { ...settings, [miss]: "" } });
			const fetches = [];
			host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
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
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
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
		host.fetch = async () => ({ status: 200, text: async () => '{"code":200}' });
		await plugin.activate(host);
		assert.equal(host.mock.calls("requestPermission").length, 0);
	});

describe("测试按钮与图标", () => {
	it("单条 iconOverride 优先于设置里的 icon", () => {
		const p = buildPayload({ barkKey: "K1", icon: "https://cfg/i.png" }, { kind: "done", title: "t", body: "b", iconOverride: "https://shot/a.png" });
		assert.equal(p.icon, "https://shot/a.png");
	});

	it("两处都空 → payload 不带 icon 字段（走 App 默认图标）", () => {
		const p = buildPayload({ barkKey: "K1", icon: "" }, { kind: "done", title: "t", body: "b" });
		assert.equal("icon" in p, false);
	});

	it("🖼️ 带图测试用输入框的 URL，📣 文字自检回落到设置值", async () => {
		const cases = [
			{ msgIcon: "https://shot/a.png", cfgIcon: "", want: "https://shot/a.png" },
			{ msgIcon: "", cfgIcon: "https://cfg/i.png", want: "https://cfg/i.png" },
			{ msgIcon: "", cfgIcon: "", want: undefined },
		];
		for (const c of cases) {
			const host = createMockHost({ settings: { ...settings, icon: c.cfgIcon } });
			host.storage.set("boot:lastPing", Date.now());
			const fetches = [];
			host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
			await plugin.activate(host);
			host.mock.emit("onMessage", c.msgIcon ? { action: "bark-notify:test", icon: c.msgIcon } : { action: "bark-notify:test" });
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(fetches.length, 1, `应推一条（icon=${JSON.stringify(c.msgIcon)}）`);
			const body = JSON.parse(fetches[0].init.body);
			assert.equal(body.icon, c.want, `icon 应为 ${c.want}`);
			assert.match(body.title, c.msgIcon ? /🖼️ 带图测试/ : /🔔 Bark 自检/);
		}
	});

	it("测试推送无视档位与前台静音（force），静音档也能验通道", async () => {
		const host = createMockHost({ settings: { ...settings, mode: "silent", muteWhenActive: 3600 } });
		host.storage.set("boot:lastPing", Date.now());
		const fetches = [];
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onMessage", { action: "bark-notify:test" }); // onMessage 顺手把「人在屏前」刷新了
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1, "静音档 + 前台活跃也要能测出通道");
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
		host.fetch = async (url, init) => { fetches.push({ url, init }); return { status: 200, text: async () => '{"code":200}' }; };
		await plugin.activate(host);
		host.mock.emit("onRunEvent", { type: "run_end", stopReason: "end_turn", conversationId: "c-url", at: Date.now() });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fetches.length, 1);
		const body = JSON.parse(fetches[0].init.body);
		assert.equal(body.title, "✅ pi · 任务完成");
		assert.equal(/https?:/.test(body.title), false);
	});
});
});
