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
- `keepTurns` — 保留最近多少轮用户消息**完全不动**，默认 2（与 `dsh-ebbing-context` 的 `keepTurns` 对齐，避免两套改写边界交叉）。当前轮永远不碰
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

## 配对是原子的（0.1.2 修）

宿主的校验是硬的：一条 assistant 里的**每个** `tool_use`，必须在**紧接着的一条 user** 的 `tool_result` 里**全部**命中。少一个就：

```
INVALID_REQUEST  DeepSeek Messages tool calls need immediate results
```

旧版按单条事件各自决策，遇到并行调用就会这样断：

```
assistant [call c1, call c2]   ← 整条受保护，两个 call 都留着
tool result c1                 ← 没被保护，抹成空消息，消失
tool result c2                 ← 触发保护，留下
→ c1 永远补不上结果 → 整轮被拒
```

现在：

- `closeOver()` 把保护集合闭包成完整组（assistant ↔ 它全部 result，双向）
- 瘦身分两遍：先判 assistant 瘦不瘦，`tool/result` 只在**它的 owner 也被瘦**时才抹
- `repairBrokenGroups()` 在 `agent/pre-step` 每步自检，把断掉的组整组拉回原文（幂等，没坏账就什么都不写）

已经坏掉的会话不用手动救：重启宿主、打开它、发一句话，自愈。想手动确认就 `slim_context({ repair: true })`。

## 撤销与恢复

投影是**累积覆盖**，后写的盖先写的。要撤回某一批，再写一条 `plugin:dsh-context-slim/rewrite`，把那些 seq 映射回原消息即可。

原始事件和原文永远在日志里，`session_event_read` 按事件号能读回来。

## 安装

### 先对版本

这个插件吃宿主的内部接口，`package.json` 里卡的是：

```json
"engines": { "dsh": ">=0.2.0-0 <0.3.0-0" }
```

**版本对不上时它不报错，是静默不加载。** 现象是：挂载写了、看起来也在，但 `slim_context` 这个工具根本不出现，或者出现了调不动。别去别处找原因，先看这一条。

### 从 GitHub 装（推荐）

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add github:NayuA0/dsh-context-slim
```

再往 `cordis.patch.yml` 的 `- insert:` 列表里加（**必须在 insert 的子列表里**，写在文件顶层宿主不读）：

```yaml
- id: dsh-context-slim
  name: dsh-context-slim
```

重启宿主 —— **没有热重载**。起来之后用 `cordis_inspect_query` 的 `Config.listConfigs` 按包名查一次，查得到才算挂上了。

### 跟着源码改

```bash
git clone https://github.com/NayuA0/dsh-context-slim
cd ~/.dsh/profiles/<你的 profile>
pnpm add file:<你 clone 的位置>/dsh-context-slim
```

改完源码记得同步到 `node_modules` 那一份 —— **两份不是硬链接**（`ls -i` 看 inode 就知道，不一样），只改源码不会生效。

### 别把它当长期依赖

它用的是 `registerMessageProjection` 这类宿主内部接口，DSH 升级就可能坏。所以没有 npm 发布、也不打算发 —— 从 GitHub 装，什么坏了能一眼看出装的是哪一天的 commit。

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
- **别拆散「工具对 → system/developer 更新」**，见下节。拆了整轮请求会被服务端拒

## ⚠️ `UNSUPPORTED_CONTENT`：一个真炸过的坑

2026-11-18 真出过事——瘦身之后**整轮请求被服务端拒，怎么发都发不出去**：

```
DeepSeek Messages cannot represent system update without a preceding user or tool-result turn
代码：UNSUPPORTED_CONTENT
```

### 根因

DeepSeek Messages 有一条没写进文档的顺序规则：

> `system/message` 和 `developer/message` 会被转成 **system update**，
> 而 system update 前面必须紧跟一条 **user 消息或工具结果**。

工具结果在 wire 格式里映射成 user 角色，所以正常是这样，合法：

```
assistant + tool_call
tool result          ← 映射成 user
system update        ← 前面是 user，允许
assistant
```

但 L2/L3 会把工具结果投影成**空 assistant**，空消息被序列化器直接跳过。前一条就变成了 assistant：

```
assistant            ← tool_call 也被删了
system update        ← 前面既不是 user 也不是工具结果
assistant            ← 非法，服务端拒整轮
```

### 怎么修的

`protectedToolPairs(session)`：扫当前可见 surface 里的 `system/message` 和 `developer/message`，
对每条找出**紧挨在它前面的工具结果**，再往前找到对应的 assistant 工具调用，两边都标成受保护、不参与瘦身。

`restoreProtectedToolPairs()`：对已经被旧版删掉的，写一条 `level: 0` 投影把原消息恢复回去。

两个时机：`session/created` 后一次；`agent/pre-step` **每轮请求前**再查一次（兜底 —— 恢复钩子没跑完、或者后来又新增了投影，这一步能接住）。

### 给改这块代码的人的底线

> **任何会被 DeepSeek 转成 system update 的消息，它前面紧挨的工具调用对，不能单独拆掉。**

回归用例（改完至少要过前两条）：

1. `assistant + tool_call → tool_result → system/message → assistant`
2. `assistant + tool_call → tool_result → developer/message → assistant`
3. 连续多个 system/developer 更新
4. L2 和 L3 投影后重新构建一次消息序列
5. 旧投影恢复记录覆盖后，历史工具调用和结果仍成对

## License

MIT
