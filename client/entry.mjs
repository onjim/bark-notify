/**
 * bark-notify — 客户端面板（设置页里的插件视图）
 *
 * 只读走同域 `/plugins-api/bark-notify/status`（GET，无需桥），写操作走 ctx.send
 * 交给服务端 onClientMessage（宿主只把 /plugins/<id>/client/* 暴露给浏览器，
 * 但 plugins-api 是同域 HTTP，直接 fetch 最省事且不依赖 reply 语义）。
 */
import { defineView, onUiAction } from "./sdk/index.mjs";

const MODES = [
	{ value: "all", label: "🔔 全推" },
	{ value: "important", label: "🙋 只重要" },
	{ value: "silent", label: "🔕 静音" },
];
const RESULT_ICON = { sent: "✅", muted: "🔕", filtered: "⚪", dedup: "♻️", "in-app": "🖥️", error: "❌" };

const el = (tag, cls, text) => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = String(text);
	return node;
};

export default defineView({
	mount(root, ctx) {
		root.innerHTML = "";
		const wrap = el("div", "bn-wrap");
		wrap.setAttribute(
			"style",
			"display:flex;flex-direction:column;gap:12px;padding:12px;font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:inherit",
		);

		const head = el("div");
		head.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap");
		head.appendChild(el("strong", null, "🔔 Bark 推送"));
		const hint = el("span", null, "声音即优先级");
		hint.setAttribute("style", "opacity:.6;font-size:12px");
		head.appendChild(hint);
		wrap.appendChild(head);

		const row = el("div");
		row.setAttribute("style", "display:flex;gap:6px;flex-wrap:wrap");
		const buttons = new Map();
		for (const m of MODES) {
			const b = el("button", "bn-mode", m.label);
			b.type = "button";
			b.setAttribute(
				"style",
				"padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:12px",
			);
			b.addEventListener("click", () => {
				ctx.send?.({ action: "bark-notify:mode", value: m.value });
				for (const [, other] of buttons) other.style.background = "transparent";
				b.style.background = "rgba(127,209,255,.22)";
			});
			buttons.set(m.value, b);
			row.appendChild(b);
		}
		const test = el("button", null, "📣 文字自检");
		test.type = "button";
		test.setAttribute(
			"style",
			"padding:6px 10px;border-radius:8px;border:1px solid rgba(127,209,255,.45);background:rgba(127,209,255,.12);color:inherit;cursor:pointer;font-size:12px",
		);
		test.addEventListener("click", () => {
			ctx.send?.({ action: "bark-notify:test" });
			setTimeout(load, 600);
		});
		row.appendChild(test);

		// 图片 URL 只作用于下一次「带图测试」，不写回设置（想固定就填设置项里的 icon）
		const iconInput = el("input");
		iconInput.type = "url";
		iconInput.placeholder = "图片 URL（默认空 → 用 App 图标）";
		iconInput.setAttribute(
			"style",
			"flex:1 1 170px;min-width:140px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-size:12px",
		);
		let iconTouched = false;
		iconInput.addEventListener("input", () => { iconTouched = true; });
		const shot = el("button", null, "🖼️ 带图测试");
		shot.type = "button";
		shot.setAttribute(
			"style",
			"padding:6px 10px;border-radius:8px;border:1px solid rgba(255,180,80,.5);background:rgba(255,180,80,.14);color:inherit;cursor:pointer;font-size:12px",
		);
		shot.addEventListener("click", () => {
			const icon = String(iconInput.value || "").trim();
			ctx.send?.(icon ? { action: "bark-notify:test", icon } : { action: "bark-notify:test" });
			setTimeout(load, 600);
		});
		row.appendChild(iconInput);
		row.appendChild(shot);
		wrap.appendChild(row);

		const state = el("div", "bn-state");
		state.setAttribute("style", "opacity:.7;font-size:12px");
		state.textContent = "读取状态…";
		wrap.appendChild(state);

		const list = el("div", "bn-list");
		list.setAttribute("style", "display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto");
		wrap.appendChild(list);

		let disposed = false;

		function paint(data) {
			if (disposed || !data || typeof data !== "object") return;
			const mode = String(data.mode || "important");
			for (const [v, b] of buttons) b.style.background = v === mode ? "rgba(127,209,255,.22)" : "transparent";
			const missing = Array.isArray(data.missing) ? data.missing : [];
			state.textContent = !data.hasKey || missing.length
				? `⚠️ 必填未完成：${missing.join(" / ") || "barkKey"} —— 设置 → Bark 推送`
				: `档位 ${mode} · 密钥已配 · 默认图标 ${data.icon || "（空 → App 图标）"} · 最近 ${Array.isArray(data.recent) ? data.recent.length : 0} 条`;
			if (!iconTouched && typeof data.icon === "string") iconInput.value = data.icon;
			list.innerHTML = "";
			for (const item of Array.isArray(data.recent) ? data.recent : []) {
				const line = el("div");
				line.setAttribute(
					"style",
					"display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:8px;background:rgba(128,128,128,.08);font-size:12px",
				);
				line.appendChild(el("span", null, RESULT_ICON[String(item.result)] || "•"));
				line.appendChild(el("span", null, item.title || "(无标题)"));
				const meta = el("span", null, `${item.result || "?"}${item.kind ? ` · ${item.kind}` : ""}`);
				meta.setAttribute("style", "margin-left:auto;opacity:.55;white-space:nowrap");
				line.appendChild(meta);
				list.appendChild(line);
			}
			if (!list.children.length) {
				const empty = el("div", null, "还没有投递记录（跑一轮任务，或点上面的自检）");
				empty.setAttribute("style", "opacity:.5;font-size:12px");
				list.appendChild(empty);
			}
		}

		async function load() {
			try {
				const res = await fetch("/plugins-api/bark-notify/status", { cache: "no-store" });
				paint(await res.json());
			} catch (err) {
				if (!disposed) state.textContent = `状态读取失败：${String(err?.message || err)}`;
			}
		}

		load();
		const timer = setInterval(load, 8000);
		const offAction = onUiAction?.("bark-notify:mode", () => setTimeout(load, 300));

		return () => {
			disposed = true;
			clearInterval(timer);
			try { offAction?.(); } catch {}
		};
	},
});
