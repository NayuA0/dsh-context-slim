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
			repaired: { type: "integer" },
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

/**
 * ── 配对组：本插件唯一的安全边界 ─────────────────────────────
 * 宿主（DeepSeek provider）的校验是硬的：
 *   一条 assistant 里的每个 tool_use，必须在**紧接着的一条 user** 的
 *   tool_result 里全部命中，少一个就 INVALID_REQUEST
 *   （"DeepSeek Messages tool calls need immediate results"）。
 *
 * 所以「一条 assistant 消息 + 它所有 tool-call 的所有 tool/result」
 * 是**一个不可分割的单元**：要么整组瘦，要么整组不瘦。
 * 任何按单条事件各自决策的写法都会在并行调用上把配对拆断。
 */
function indexCalls(session) {
	const callOwner = new Map();
	const resultsByCall = new Map();
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event?.type === "assistant/message") {
			const blocks = event.data?.message?.content;
			if (!Array.isArray(blocks)) continue;
			for (const block of blocks) {
				if (block?.type === "tool-call" && typeof block.id === "string") callOwner.set(block.id, seq);
			}
		} else if (event?.type === "tool/result") {
			const callId = event.data?.message?.toolCallId;
			if (typeof callId !== "string") continue;
			if (!resultsByCall.has(callId)) resultsByCall.set(callId, []);
			resultsByCall.get(callId).push(seq);
		}
	}
	return { callOwner, resultsByCall };
}

/** 一条 assistant 消息（原始内容）对应的全部 result seq。 */
function groupResults(session, seq, resultsByCall) {
	const out = [];
	const blocks = session.eventAt(seq)?.data?.message?.content;
	if (!Array.isArray(blocks)) return out;
	for (const block of blocks) {
		if (block?.type !== "tool-call" || typeof block.id !== "string") continue;
		for (const resultSeq of resultsByCall.get(block.id) ?? []) out.push(resultSeq);
	}
	return out;
}

/** 把一批 seq 闭包成完整配对组：assistant ↔ 它全部 result，双向。 */
function closeOver(session, seeds) {
	const { callOwner, resultsByCall } = indexCalls(session);
	const out = new Set(seeds);
	for (let changed = true; changed; ) {
		changed = false;
		for (const seq of [...out]) {
			const event = session.eventAt(seq);
			if (event?.type === "assistant/message") {
				for (const resultSeq of groupResults(session, seq, resultsByCall)) {
					if (!out.has(resultSeq)) {
						out.add(resultSeq);
						changed = true;
					}
				}
			} else if (event?.type === "tool/result") {
				const owner = callOwner.get(event.data?.message?.toolCallId);
				if (owner !== void 0 && !out.has(owner)) {
					out.add(owner);
					changed = true;
				}
			}
		}
	}
	return out;
}

/** 当前仍然生效的「被抹成空消息」的 seq 集合（精确读投影记录）。 */
function squashedSeqs(session) {
	const out = new Set();
	for (let i = 0; i < session.seq; i++) {
		const event = session.eventAt(i);
		if (event?.type !== REWRITE) continue;
		const list = event.data?.rewrites;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item.seq !== "number") continue;
			const content = item.message?.content;
			if (Array.isArray(content) && content.length === 0) out.add(item.seq);
			else out.delete(item.seq);
		}
	}
	return out;
}

/** 当前生效的投影表：seq → 投影后的消息。 */
function latestProjections(session) {
	const latest = new Map();
	for (let i = 0; i < session.seq; i++) {
		const event = session.eventAt(i);
		if (event?.type !== REWRITE) continue;
		const list = event.data?.rewrites;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (item && typeof item.seq === "number" && item.message) latest.set(item.seq, item.message);
		}
	}
	return latest;
}

/**
 * In-history system and developer updates are serialized as DeepSeek system
 * updates. They require the immediately preceding tool result (and its
 * matching assistant tool call) to remain in the wire history. Protect those
 * pairs from slimming and restore any projections already written for them.
 *
 * 注意：这里返回的只是「种子」。真正的保护范围必须再过一遍 closeOver——
 * 同一个 assistant 消息常常带多个并行 tool-call，只保护触发的那一对，
 * 它兄弟的 result 仍会被抹掉，配对就断了。
 */
function protectedToolPairs(session) {
	const nodes = session.surface.nodes.slice();
	const protectedSeqs = new Set();
	for (let i = 0; i < nodes.length; i++) {
		const event = session.eventAt(nodes[i]);
		if (event?.type !== "developer/message" && event?.type !== "system/message") continue;
		let resultIndex = i - 1;
		const skippable = (type) => type === "developer/message" || type === "system/message";
		while (resultIndex >= 0 && skippable(session.eventAt(nodes[resultIndex])?.type)) {
			resultIndex -= 1;
		}
		if (resultIndex < 0) continue;
		const resultEvent = session.eventAt(nodes[resultIndex]);
		const resultMessage = resultEvent?.data?.message;
		const callId = resultMessage?.toolCallId;
		if (resultEvent?.type !== "tool/result" || typeof callId !== "string") continue;
		protectedSeqs.add(resultEvent.seq);
		for (let assistantIndex = resultIndex - 1; assistantIndex >= 0; assistantIndex--) {
			const assistantEvent = session.eventAt(nodes[assistantIndex]);
			if (assistantEvent?.type === "user/message") break;
			if (assistantEvent?.type !== "assistant/message") continue;
			const blocks = assistantEvent?.data?.message?.content;
			if (Array.isArray(blocks) && blocks.some((block) => block?.type === "tool-call" && block.id === callId)) {
				protectedSeqs.add(assistantEvent.seq);
				break;
			}
		}
	}
	return protectedSeqs;
}

/**
 * 把投影撤回到原文。传入的 seeds 会先闭包成完整配对组——
 * 只恢复 assistant 而不恢复它的 result，等于亲手制造一次配对断裂。
 */
function restoreProtectedToolPairs(session, seeds) {
	if (!seeds || seeds.size === 0) return 0;
	const protectedSeqs = closeOver(session, seeds);
	const latest = latestProjections(session);
	const rewrites = [];
	for (const seq of protectedSeqs) {
		const original = session.eventAt(seq)?.data?.message;
		const projected = latest.get(seq);
		if (!original || projected === undefined) continue;
		if (JSON.stringify(projected) === JSON.stringify(original)) continue;
		rewrites.push({ seq, message: original });
	}
	if (rewrites.length > 0) appendPluginRecord(session, REWRITE, { level: 0, rewrites });
	return rewrites.length;
}

/**
 * 自愈：历史版本留下的坏账——assistant 还留着 tool-call，但它的某个 result
 * 已经被抹成空消息（或反过来，result 还在而 call 被删）。这种会话每一轮
 * 都会 400，重试无用，只能把整组恢复成原文。
 *
 * 每步跑一次，O(surface)。正常会话 squashed 为空，直接返回。
 */
function repairBrokenGroups(session) {
	const latest = latestProjections(session);
	// 一条投影记录都没有 = 这插件没动过这段历史，没什么可修的。
	// 注意不能拿 squashedSeqs() 当判据：孤儿的形状是「调用被删、结果还在」，
	// 那种坏账里一条空消息都没有。
	if (latest.size === 0) return 0;
	const squashed = squashedSeqs(session);
	const { resultsByCall } = indexCalls(session);
	const rewrites = [];
	const seen = new Set();
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event?.type !== "assistant/message") continue;
		const blocks = event.data?.message?.content;
		if (!Array.isArray(blocks)) continue;
		const calls = blocks.filter((block) => block?.type === "tool-call" && typeof block.id === "string");
		if (calls.length === 0) continue;

		let visible;
		try {
			visible = session.deriveEventMessage(event);
		} catch {
			continue;
		}
		const visibleCalls = (visible?.content ?? []).filter(
			(block) => block?.type === "tool-call" && typeof block.id === "string"
		);

		let broken = false;
		if (visibleCalls.length > 0) {
			// call 还在 → 每个 call 至少得有一个没被抹掉的 result
			for (const block of visibleCalls) {
				const resultSeqs = resultsByCall.get(block.id) ?? [];
				if (resultSeqs.length === 0 || resultSeqs.every((s) => squashed.has(s))) {
					broken = true;
					break;
				}
			}
		} else {
			// call 被删了 → 对应的 result 如果还看得见，就是孤儿
			for (const block of calls) {
				const resultSeqs = resultsByCall.get(block.id) ?? [];
				if (resultSeqs.some((s) => !squashed.has(s))) {
					broken = true;
					break;
				}
			}
		}
		if (!broken) continue;

		for (const target of [seq, ...groupResults(session, seq, resultsByCall)]) {
			if (seen.has(target)) continue;
			const original = session.eventAt(target)?.data?.message;
			const projected = latest.get(target);
			if (!original || projected === undefined) continue;
			if (JSON.stringify(projected) === JSON.stringify(original)) continue;
			seen.add(target);
			rewrites.push({ seq: target, message: original });
		}
	}
	if (rewrites.length > 0) appendPluginRecord(session, REWRITE, { level: 0, rewrites });
	return rewrites.length;
}

function slim(agent, ctx, args) {
	if (agent === void 0) throw new Error("需要调用方是运行中的 agent");
	const session = ctx.sessions.get(agent.id);
	if (!session) throw new Error("拿不到当前会话");

	const level = [1, 2, 3].includes(args.level) ? args.level : 3;
	const keepTurns = Number.isInteger(args.keepTurns) && args.keepTurns >= 0 ? args.keepTurns : 2;
	const dryRun = args.dryRun === true;

	// 只做配对自检与恢复：把断了配对的组整组拉回原文，不瘦任何东西。
	if (args.repair === true) {
		const repaired = repairBrokenGroups(session);
		return {
			ok: true,
			level: 0,
			dryRun,
			keepTurns,
			surfaceNodes: session.surface.nodes.length,
			scanned: 0,
			argsCleared: 0,
			toolsDropped: 0,
			resultsSquashed: 0,
			reasoningStripped: 0,
			untouched: 0,
			repaired
		};
	}

	const nodes = session.surface.nodes.slice();
	// 种子 → 闭包成完整配对组。只保护触发的那一对是不够的：同一个 assistant
	// 消息常常带并行 tool-call，兄弟 result 被抹掉照样 400。
	const protectedSeqs = closeOver(session, protectedToolPairs(session));
	if (!dryRun) restoreProtectedToolPairs(session, protectedSeqs);
	const userIdx = [];
	nodes.forEach((seq, i) => {
		if (session.eventAt(seq)?.type === "user/message") userIdx.push(i);
	});
	const cut = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : 0;
	const targets = nodes.slice(0, cut);
	const { callOwner, resultsByCall } = indexCalls(session);

	// 幂等：已经瘦到这一级（或更深）的 seq 不再重复处理。
	// level 0 是撤销记录——它把投影还原了，等于「这一条还没瘦过」，必须从表里
	// 删掉；否则 restore 之后会永远卡在"已处理"，会话再也修不回来。
	const done = new Map();
	for (let i = 0; i < session.seq; i++) {
		const prior = session.eventAt(i);
		if (!prior || prior.type !== REWRITE) continue;
		const at = Number(prior.data?.level);
		const list = prior.data?.rewrites;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item.seq !== "number") continue;
			if (!Number.isFinite(at) || at <= 0) done.delete(item.seq);
			else done.set(item.seq, Math.max(done.get(item.seq) ?? 0, at));
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
	// 本轮决定瘦身的 assistant。tool/result 只有 owner 也被瘦身时才抹——
	// 否则就是「调用没了、结果还在」的孤儿。
	const slimmed = new Set();

	// ── 第一遍：只判 assistant ──────────────────────────────
	for (const seq of targets) {
		const event = session.eventAt(seq);
		if (!event) {
			stats.untouched += 1;
			continue;
		}
		if (event.type !== "assistant/message") {
			if (event.type !== "tool/result") stats.untouched += 1;
			continue;
		}
		if (protectedSeqs.has(seq) || (done.get(seq) ?? 0) >= level) {
			stats.untouched += 1;
			continue;
		}

		let message;
		try {
			message = session.deriveEventMessage(event);
		} catch {
			// 派生不出来就别动它，更不能动它的 result —— 整组留着是安全的
			stats.untouched += 1;
			continue;
		}
		const next = stripBlocks(message, level);
		if (!next) {
			stats.untouched += 1;
			continue;
		}
		if (next.clearArgs) stats.argsCleared += 1;
		if (next.dropTools) {
			stats.toolsDropped += 1;
			slimmed.add(seq);
		}
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

	// ── 第二遍：tool/result 跟着它的 owner 走 ────────────────
	for (const seq of targets) {
		const event = session.eventAt(seq);
		if (event?.type !== "tool/result") continue;
		if (level < 2 || protectedSeqs.has(seq) || (done.get(seq) ?? 0) >= level) {
			stats.untouched += 1;
			continue;
		}
		const owner = callOwner.get(event.data?.message?.toolCallId);
		// owner 这轮没被瘦身（受保护 / 已处理 / 派生失败 / 在保留区）→ 结果必须留着
		if (owner === void 0 || !slimmed.has(owner)) {
			stats.untouched += 1;
			continue;
		}
		stats.resultsSquashed += 1;
		rewrites.push({ seq, message: silentMessage() });
	}

	if (!dryRun && rewrites.length > 0) {
		stats.recordSeq = appendPluginRecord(session, REWRITE, { level, rewrites });
	}
	return stats;
}

/**
 * 发请求前的守门：先恢复受保护的配对组，再把历史里已经断掉的组整组拉回来。
 * 两步都只写 level 0 记录（幂等，没有可恢复的就什么都不写），
 * 抛错也绝不能拦住这一轮——最坏的情况是这一轮维持原样。
 */
function guardPairs(session) {
	try {
		restoreProtectedToolPairs(session, protectedToolPairs(session));
	} catch {
		// 恢复是尽力而为；下一步还会再来一次
	}
	try {
		repairBrokenGroups(session);
	} catch {
		// 自愈同理：修不好也不能让会话起不来
	}
}

export function apply(ctx) {
	ctx.on("session/created", (session) => {
		setImmediate(() => guardPairs(session));
	});

	ctx.on("agent/pre-step", (_payload, next) => {
		const agent = _payload?.agent;
		if (agent !== void 0) {
			const session = ctx.sessions.get(agent.id);
			if (session) guardPairs(session);
		}
		return next();
	});

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
				"阶梯式上下文瘦身：按 level 一级一级把旧对话的「过程」从模型可见历史里去掉，用户说的话和助手回复的正文始终保留。level=1 只清工具参数（arguments 置为 {}）；level=2 再让工具整体消失（tool-call 块去掉、对应 tool/result 不再产生消息）；level=3 再去掉思考链。不是摘要——不写摘要块，旧轮次读起来就是当时的原话。L4（正文也折成摘要）不在本工具里，用 compress。空间不够时从低往高升，别跳级。只处理最近 keepTurns 轮用户消息之前的节点，当前轮永远不碰。原始内容仍在事件日志里，写入的是一条可撤销的投影记录（不动历史顺序）。先用 dryRun 看会动多少条。配对是硬性的：一条助手消息和它全部工具结果同进同退——只删一半会被宿主判成 tool calls need immediate results。",
			parameters: {
				level: {
					type: "integer",
					description: "瘦身层级：1=清工具参数，2=再让工具整体消失，3=再去掉思考链。默认 3。"
				},
				keepTurns: {
					type: "integer",
					description: "保留最近多少轮用户消息完全不动（默认 2，与 dsh-ebbing-context 的 keepTurns 对齐，避免两套改写边界交叉）。更早的轮次才会被瘦身。"
				},
				dryRun: {
					type: "boolean",
					description: "true = 只统计会处理多少条，不写任何东西。默认 false。"
				},
				repair: {
					type: "boolean",
					description: "true = 只做配对自检：把「助手调用还在、结果却被抹掉」的组整组恢复成原文，不瘦任何东西。会话报 tool calls need immediate results 时用它救场。"
				}
			},
			output: OUTPUT,
			presentCall: (args) => ({
				card: "generic",
				title: "上下文瘦身",
				kind: "other",
				rawInput: args.repair
					? "配对自检与恢复"
					: `L${args.level ?? 3} keepTurns=${args.keepTurns ?? 2}${args.dryRun ? " (dry-run)" : ""}`
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
