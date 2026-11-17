/**
 * dsh-context-slim —— 阶梯式上下文瘦身（不是摘要）
 *
 * 思路：空间不够时**一级一级加码**，不是一次折成摘要。
 * 升到 L2/L3 之后，用户的原话还在，只是过程被拿掉了。
 *
 *   L1  舍工具参数（tool-call 的 arguments → "{}"）
 *   L2  L1 + 工具整体（tool-call 块消失，对应 tool/result 不再产生消息）
 *   L3  L2 + 思考链（reasoning 块消失）
 *   L4  正文也折成摘要 —— 不在本插件，交给分层压缩（compress）
 *
 * ── 为什么不用 surfaceOp replace ──────────────────────────────
 * 宿主把这条路写死了：
 *   SurfaceIntent<'assistant/message'> = { surfaceOp; sourceEventSeqs?: never }
 * 带 sourceEventSeqs → "assistant/message embeds its source stream and cannot carry sourceEventSeqs"
 * 不带           → "sourceEventSeqs must include every shadowed surface node"
 * 两条互斥，所以 assistant 消息**不能**当表面替换的产物。
 *
 * ── 正路：message projection ─────────────────────────────────
 * 宿主在 `ctx.sessions` 上留了明写的扩展点：
 *   registerMessageProjection({ type, project(event, ctx) → Map<seq, Message> })
 * deriveEventMessage 的第一句就是：
 *   const projected = projectedMessages?.get(event.seq); if (projected) return projected
 * 也就是：投影表按 seq 覆盖消息内容。
 *
 * 所以本插件写一个**自己的**日志事件（plugin record），进 surface 之外的日志，
 * 在它的投影里返回「旧 seq → 瘦身后的 Message」这张表。
 * 不碰 surface、不改历史顺序、不动原始事件，只在「派生成给模型看的那份消息」时换内容。
 *
 * ── 本机接口约定（DSH 0.2.x，写死免得再踩）────────────────────
 *   · 会话：ctx.sessions.get(agent.id)，不是 agent.session；inject 必须声明 sessions
 *   · 事件：session.eventAt(seq)，不是 session.events[seq]
 *   · 插件事件：appendPluginRecord(session, type, data)
 *       type 必须 `plugin:` 开头 + 小写斜杠段；自动带 ignorable:true；
 *       不进 surface；fork/resume 会带上；宿主不认识时保留并跳过
 *   · 投影返回的 Map 只能「换内容」，不能删节点——所以 tool/result 缩成空 assistant
 *     （空 assistant 不产生 wire 消息，宿主自己 max-tokens 时就这么干）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";

export const name = "dsh-context-slim";

export const inject = ["tools", "agents", "sessions"];

/** 必须符合 plugin record 语法：plugin: + 小写斜杠段。 */
const REWRITE = "plugin:dsh-context-slim/rewrite";

/** arguments 在事件里是 JSON 字符串，清空必须是合法 JSON。 */
const ARGS_MARK = "{}";

const OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: true,
		properties: {
			ok: { type: "boolean", required: true },
			error: { type: "string" },
			level: { type: "integer" },
			dryRun: { type: "boolean" },
			keepTurns: { type: "integer" },
			surfaceNodes: { type: "integer" },
			scanned: { type: "integer" },
			argsCleared: { type: "integer" },
			toolsDropped: { type: "integer" },
			resultsSquashed: { type: "integer" },
			reasoningStripped: { type: "integer" },
			untouched: { type: "integer" },
			recordSeq: { type: "integer" }
		}
	},
	render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
};

function hasArgs(block) {
	if (block?.arguments === void 0) return false;
	const v = block.arguments;
	if (typeof v === "string") return v.trim() !== "" && v.trim() !== "{}";
	if (v && typeof v === "object") return Object.keys(v).length > 0;
	return false;
}

/** 按 level 算这一条 assistant 消息要不要瘦、瘦成什么。返回 null = 不动。 */
function stripBlocks(message, level) {
	const content = Array.isArray(message?.content) ? message.content : [];
	const calls = content.filter((b) => b?.type === "tool-call");
	const reasons = content.filter((b) => b?.type === "reasoning");
	const dropTools = level >= 2 && calls.length > 0;
	const clearArgs = level >= 1 && !dropTools && calls.some(hasArgs);
	const dropReasoning = level >= 3 && reasons.length > 0;
	if (!dropTools && !clearArgs && !dropReasoning) return null;

	const next = [];
	for (const block of content) {
		if (block?.type === "reasoning") {
			if (!dropReasoning) next.push(block);
			continue;
		}
		if (block?.type === "tool-call") {
			if (dropTools) continue;
			if (clearArgs && hasArgs(block)) {
				next.push({ ...block, arguments: ARGS_MARK });
				continue;
			}
		}
		next.push(block);
	}
	return { content: next, dropTools, clearArgs, dropReasoning };
}

/** 不产生 wire 消息的空 assistant（用于让 tool/result 节点闭嘴）。 */
function silentMessage() {
	return createAssistantMessage({
		content: [],
		source: { kind: "model", provider: "dsh-context-slim", model: "slim" }
	});
}

function slim(agent, ctx, args) {
	if (agent === void 0) throw new Error("需要调用方是运行中的 agent");
	const session = ctx.sessions.get(agent.id);
	if (!session) throw new Error("拿不到当前会话");

	const level = [1, 2, 3].includes(args.level) ? args.level : 3;
	const keepTurns = Number.isInteger(args.keepTurns) && args.keepTurns >= 0 ? args.keepTurns : 6;
	const dryRun = args.dryRun === true;

	const nodes = session.surface.nodes.slice();
	const userIdx = [];
	nodes.forEach((seq, i) => {
		if (session.eventAt(seq)?.type === "user/message") userIdx.push(i);
	});
	const cut = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : 0;
	const targets = nodes.slice(0, cut);

	// 幂等：已经瘦到这一级（或更深）的 seq 不再重复处理。
	// 投影表本身只是覆盖，重复写不会出错，但会让日志无限变长、统计永远不为 0。
	const done = new Map();
	for (let i = 0; i < session.seq; i++) {
		const prior = session.eventAt(i);
		if (!prior || prior.type !== REWRITE) continue;
		const at = Number(prior.data?.level);
		const list = prior.data?.rewrites;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (item && typeof item.seq === "number") {
				done.set(item.seq, Math.max(done.get(item.seq) ?? 0, Number.isFinite(at) ? at : 0));
			}
		}
	}

	const stats = {
		ok: true,
		level,
		dryRun,
		keepTurns,
		surfaceNodes: nodes.length,
		scanned: targets.length,
		argsCleared: 0,
		toolsDropped: 0,
		resultsSquashed: 0,
		reasoningStripped: 0,
		untouched: 0
	};

	const rewrites = [];
	for (const seq of targets) {
		if ((done.get(seq) ?? 0) >= level) {
			stats.untouched += 1;
			continue;
		}
		const event = session.eventAt(seq);
		if (!event) {
			stats.untouched += 1;
			continue;
		}

		if (event.type === "tool/result") {
			if (level < 2) {
				stats.untouched += 1;
				continue;
			}
			stats.resultsSquashed += 1;
			rewrites.push({ seq, message: silentMessage() });
			continue;
		}

		if (event.type !== "assistant/message") {
			stats.untouched += 1;
			continue;
		}

		let message;
		try {
			message = session.deriveEventMessage(event);
		} catch {
			stats.untouched += 1;
			continue;
		}
		const next = stripBlocks(message, level);
		if (!next) {
			stats.untouched += 1;
			continue;
		}
		if (next.clearArgs) stats.argsCleared += 1;
		if (next.dropTools) stats.toolsDropped += 1;
		if (next.dropReasoning) stats.reasoningStripped += 1;

		const source =
			message?.source && typeof message.source === "object"
				? message.source
				: { kind: "model", provider: "dsh-context-slim", model: "slim" };
		rewrites.push({
			seq,
			message: createAssistantMessage({ content: next.content, source })
		});
	}

	if (!dryRun && rewrites.length > 0) {
		stats.recordSeq = appendPluginRecord(session, REWRITE, { level, rewrites });
	}
	return stats;
}

export function apply(ctx) {
	ctx.sessions.registerMessageProjection({
		type: REWRITE,
		project(event) {
			const out = new Map();
			const list = event?.data?.rewrites;
			if (Array.isArray(list)) {
				for (const item of list) {
					if (item && typeof item.seq === "number" && item.message) {
						out.set(item.seq, item.message);
					}
				}
			}
			return out;
		}
	});

	ctx.tools.register(
		defineTool({
			name: "slim_context",
			description:
				"阶梯式上下文瘦身：按 level 一级一级把旧对话的「过程」从模型可见历史里去掉，用户说的话和助手回复的正文始终保留。level=1 只清工具参数（arguments 置为 {}）；level=2 再让工具整体消失（tool-call 块去掉、对应 tool/result 不再产生消息）；level=3 再去掉思考链。不是摘要——不写摘要块，旧轮次读起来就是当时的原话。L4（正文也折成摘要）不在本工具里，用 compress。空间不够时从低往高升，别跳级。只处理最近 keepTurns 轮用户消息之前的节点，当前轮永远不碰。原始内容仍在事件日志里，写入的是一条可撤销的投影记录（不动历史顺序）。先用 dryRun 看会动多少条。",
			parameters: {
				level: {
					type: "integer",
					description: "瘦身层级：1=清工具参数，2=再让工具整体消失，3=再去掉思考链。默认 3。"
				},
				keepTurns: {
					type: "integer",
					description: "保留最近多少轮用户消息完全不动（默认 6）。更早的轮次才会被瘦身。"
				},
				dryRun: {
					type: "boolean",
					description: "true = 只统计会处理多少条，不写任何东西。默认 false。"
				}
			},
			output: OUTPUT,
			presentCall: (args) => ({
				card: "generic",
				title: "上下文瘦身",
				kind: "other",
				rawInput: `L${args.level ?? 3} keepTurns=${args.keepTurns ?? 6}${args.dryRun ? " (dry-run)" : ""}`
			}),
			execute: (args, exec) => {
				try {
					return slim(exec.agent, ctx, args ?? {});
				} catch (error) {
					return { ok: false, error: String((error && error.message) || error) };
				}
			}
		})
	);
}
