# dsh-context-slim —— 阶梯式上下文瘦身

**不是摘要。** 按层把旧对话的「过程」从模型可见历史里去掉，用户说的话和助手回复的**正文一个字都不动**。

空间不够时一级一级往下走，不是一次折成摘要 —— 绝大多数时候升到第二三级就够了，原话一直还在。

## 四层

| 层 | 舍什么 | 留下什么 |
|---|---|---|
| **L1** | 工具**参数**（`tool-call.arguments` → `"{}"`） | 调用名、结果、思考、正文 |
| **L2** | L1 + **工具整体**（`tool-call` 块消失，对应 `tool/result` 不再产生消息） | 调用名、思考、正文 |
| **L3** | L2 + **思考链**（`reasoning` 块消失） | 调用名、正文 |
| **L4** | L3 + 正文折成摘要 | 只剩摘要块 |

L4 **不在本插件里**，交给分层压缩（`compress`）——它已经有分层区和配额，重写一套不划算。

不跳级：L1 够就别碰 L2；L4 之前必须走完 L1–L3。

## 用法

```js
slim_context({ level: 1, dryRun: true })   // 干跑，只报会动多少条
slim_context({ level: 1 })                 // 真跑：清工具参数
slim_context({ level: 2 })                 // 再让工具整体消失
slim_context({ level: 3 })                 // 再去掉思考链
```

参数：

- `level` — 1 / 2 / 3，默认 3
- `keepTurns` — 保留最近多少轮用户消息**完全不动**，默认 6。当前轮永远不碰
- `dryRun` — 只统计不写入

## 为什么不用 surfaceOp replace

宿主把那条路写死了（`@deepseek-ai/dsh-session` 的类型定义）：

```ts
SurfaceIntent<'assistant/message'> = {
  surfaceOp: SurfaceOp
  sourceEventSeqs?: never   // ← 天生不许
}
```

带 `sourceEventSeqs` →

```
assistant/message embeds its source stream and cannot carry sourceEventSeqs
```

不带 →

```
surface replace: sourceEventSeqs must include every shadowed surface node
```

两条互斥，结论：**一条 assistant 消息不能当表面替换的产物**。这条缝只开给 `user/message`、`compaction/summary` 那类没有 source stream 的事件。

## 正路：message projection

宿主在 `ctx.sessions` 上留了明写的扩展点：

```js
ctx.sessions.registerMessageProjection({ type, project(event, context) })
```

`deriveEventMessage` 的第一句就是：

```js
const projected = projectedMessages?.get(event.seq)
if (projected !== undefined) return projected
```

也就是：**投影表按 seq 覆盖消息内容**。

所以本插件做的事是：

1. 写一条**自己的**日志事件（`plugin:` 命名空间，`ignorable: true`，不进 surface）
2. 在它的投影里返回 `Map<旧 seq, 瘦身后的 Message>`

不碰 surface、不改历史顺序、不动原始事件。只在「把日志派生成给模型看的那份消息」时换内容。

## 和压缩的区别

- **压缩**（`compress`）：把一段对话折成一条摘要，原文移出上下文 —— 文字会丢
- **瘦身**（本插件）：只摘掉过程（参数 / 工具 / 思考），**原话留着** —— 字都还在

## 撤销与恢复

投影是**累积覆盖**，后写的盖先写的。要撤回某一批，再写一条 `plugin:dsh-context-slim/rewrite`，把那些 seq 映射回原消息即可。

原始事件和原文永远在日志里，`session_event_read` 按事件号能读回来。

## 安装

本机（profile）：

```bash
# 1. 复制到 profile 的 node_modules
cp -r . ~/.dsh/profiles/desktop/node_modules/dsh-context-slim/

# 2. package.json 的 dependencies 里加（路径换成你放源码的位置）
"dsh-context-slim": "file:<你的路径>/dsh-context-slim"

# 3. cordis.patch.yml 的 - insert: 列表里加（必须在 insert 子列表里，不是顶层）
- id: dsh-context-slim
  name: dsh-context-slim
```

**改完要重启宿主**（没有热重载）。

## 本机接口约定（DSH 0.2.x，写死免得再踩）

- 会话：`ctx.sessions.get(agent.id)`，**不是** `agent.session`；`inject` 必须声明 `"sessions"`
- 事件：`session.eventAt(seq)`，**不是** `session.events[seq]`
- 插件事件：`appendPluginRecord(session, type, data)`
  - `type` 必须 `plugin:` 开头 + 小写斜杠段
  - 自动带 `ignorable: true`
  - 不进 surface；fork / resume 会带上；宿主不认识时保留并跳过
- 投影返回的 Map 只能**换内容**，不能删节点 —— 所以 `tool/result` 缩成空 assistant
  （空 assistant 不产生 wire 消息，宿主自己 max-tokens 时就这么干）

## 风险

- **不可逆**（在模型可见的上下文里）。原文还在日志里，但换回去要再写一条投影记录
- `tool-call` / `tool/result` 必须成对处理。L2 把两边一起拿掉，不会悬空
- 只在 `keepTurns` 之外动手，当前轮永远不碰

## License

MIT
