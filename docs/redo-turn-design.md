# 重做某一轮的实现选型与代价

记录时间：2026-11-09 ｜ 对应版本：dsh-better-session 1.1.0 ｜ DSH：0.2.2-rc.1

这份文档记录「重做某一轮」功能的技术选型、被否决的方案、以及升级时需要重新审视的点。

**为什么单独放这里**：这些内容对使用者没有价值（他们只关心怎么用），但对维护者判断「什么时候可以改成更干净的实现」是必需的。README 保持用户视角。

---

## 需求原话

> 当前会话已经进行了 4 轮。我希望重新执行第 4 轮：上下文截断到第 3 轮，然后概括性地总结旧的第 4 轮已经做了啥，然后在当前会话重新发送第 4 轮的消息，把原来的第 4 轮消息抹除掉。

关键约束（用户明确过）：

- **不接受 fork 出新会话**——必须留在当前会话
- 产物回退做不到，可以接受
- 界面上旧轮次要能处理（折叠或隐藏）

---

## 最终选型

### 写入方式：一个带 `replace` 的 `user/message`

```
session.append('user/message', {
  role: 'user',
  content: [{ type: 'text', text: standIn }],
  source: { kind: 'redo-checkpoint', redoId },
}, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [...shadowedSeqs],
})
```

**只此一个事件，没有任何 `compaction/*` 事件。**

理由：

1. `replace` 是 DSH 表达「遮蔽既有历史」的唯一正规方式。日志 append-only，物理删除不存在。
2. **刻意不写 `compaction/start|summary|end`**。官方 `ui-chat` 里有一段：

   ```js
   function isCompactionCheckpoint(event) {
     if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
     return event.data.source.kind === "compact-checkpoint";
   }
   ```

   如果伪造 compaction 事务，`/compact` 的渲染、审计、以及任何读 compaction 状态的代码都会把我们的重做当成真实的自动压缩。这是语义污染。

3. 自定义 `redo-checkpoint` 标记让读取方可以区分，且不落入任何官方分支。

### 短轮次：不走模型，加标记包住原文

用户提出：**「如果轮次太短，就不走模型压缩，改为加一个前缀或后缀包起来」**。

实现为 `standInText()`：

- ≥ 600 字符 → 调模型写摘要，`mode: 'summary'`
- < 600 字符 → 固定说明 + 原文，`mode: 'notice'`

这条设计顺带解决了一个官方硬限制：`dsh-compaction-basic` 里有

```js
if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount)
  throw new Error('summary is not smaller than the shadowed content')
```

**摘要不比原文小就报错**。短轮次几乎必然触发。自己写 replace 就绕开了它，同时不必伪造 compaction 事件。

### 定位方式：Client 传 `rpcId`，Host 反查

**这是踩过坑的地方。**

`conversation.chat.user.before` 的 owner props 只有：

```ts
{ source: unknown, kind: 'user' | 'steering' }
```

官方原文：**"Chat does not interpret message sources."**

而真实 `source`（从会话日志实测）是：

```json
{ "kind": "user", "rpcId": "a66c05b4-...", "clientTimeZone": "Asia/Shanghai" }
```

**没有 `id`，没有 `seq`。**

第一版代码写了 `props.source.seq`，永远 `undefined`，所以按钮一次都没渲染。这就是「编辑入口看不到」的直接原因。

最终方案：Client 把 `source.rpcId` 交给 Host，Host 在会话日志里扫描 `user/message` 的 `data.source.rpcId` 匹配，得到 `seq`。

**这个反查必须在 Host 做**，因为 Client 拿不到权威的日志位置；在浏览器里猜快照结构等于拿正确性赌博。

### 边界校验：自行重算工具配对平衡

`validateSpan` 自行重算，不 import `@deepseek-ai/dsh-compaction`：

```
span 起点前、终点后，未完成的 tool-call 数必须为 0
```

理由：profile 插件依赖内部包会锁死到某个 DSH 构建。代价是这段逻辑与官方实现有重复，需要在升级时对照。

---

## 被否决的方案

### ❌ 方案一：`ctx.compaction.compactRegion()`

最初打算直接用官方 API。**实测该服务在当前 profile 里不存在**（探针确认 `compaction.present === false`，`dsh-compaction-basic` 状态 `inactive`）。

即使用户装上它，也会带来两个额外问题：

- 启用自动压缩（长对话时自动摘要，行为变化）
- 「摘要必须更小」的硬限制会让短轮次直接失败

### ❌ 方案二：fork 出新会话

**用户明确否决。** 而且值是反的：编辑的意义就是不留废会话。

### ❌ 方案三：覆盖 `conversation.chat.node` 的 `user` key

用户一度选了这个，探查后改为 A 方案的 rpcId 路线。

否决原因：

- 官方 `user` 渲染器**源码不随包发布**（只有 `lib/client.js`，15589 行编译产物）
- 覆盖它必须从零重写：气泡、时间戳、复制按钮、图片/文件附件、引用块、pending/echo 状态
- 官方特别声明 `conversation.chat.user.content` Factory **"is not a global user-content override entry point"**——覆盖 `chat.node` 是绕开设计意图
- 风险：任何一项没做到，用户消息显示就会退化

**这条路在升级后未必更好，只在需要「界面上真正隐藏旧轮次」时才值得重新考虑。**

---

## 已知限制（用户已接受）

### 1. 界面上旧轮次仍然可见

DSH 明确把两个概念分开：

> `isAppendSurfaceEvent`: "the model-visible surface deliberately shadows replaced ranges, so it is **the wrong source for a human transcript** — a landed replacement would erase conversation the user already saw. **Append-origin events are that transcript's durable source material; replacement copies stay model-only.**"

聊天界面渲染的是**原始追加事件**，不是模型视图。所以 replace 之后：

- 模型看到摘要 ✅
- 界面仍是原文（符合 DSH 设计，不符合用户最初的「抹除」诉求）

### 2. KV cache 从被替换的第一条起失效

官方文档：

> **KV Cache effect:** ...A `replace` operation **invalidates reuse from the first shadowed message** even though the underlying event log stays append-only.

所以重做一次 = 第 4 轮的输入重新计费。前三轮的前缀缓存仍然有效。

### 3. 产物不回退

文件已被 Agent 写入就是写入了，DSH 没有可回滚的快照。UI 提示语已如实说明，不承诺回退。

---

## 升级时需要重新审视的点

按优先级排列：

| 触发条件 | 要审视什么 |
|---|---|
| DSH 提供「原地编辑轮次」官方能力 | 直接迁移，删掉本功能 |
| DSH 提供按 `seq` 回滚/截断会话的 API | 用官方 API 替换手写 replace |
| `compaction` 变成常驻服务 | 考虑改用 `compactRegion` 并删掉自己的摘要逻辑 |
| `conversation.chat.user.before` 的 props 增加 `seq`/`messageId` | 删掉 `resolveMessageSeq` 的 rpcId 反查 |
| DSH 给转录提供「隐藏被替换轮次」的开关 | 打开它，满足用户最初的「界面抹除」诉求 |
| `user` 渲染器源码开始随包发布 | 重估覆盖 `chat.node` 的成本 |
| 官方 `dsh-compaction-basic` 去掉「摘要必须更小」限制 | 短轮次可以统一走摘要路径 |

---

## 验证记录

- `node test/redo.mjs` —— 41 项，覆盖：轮次定位、运行中拒绝、span 平衡校验、只追加一个事件、不得出现 compaction 事件、`rpcId` 反查命中与未命中、摘要/包文两条分支
- 探针实测：`ctx.compaction` 不存在；`ctx.sessions` / `ctx.agents` / `ctx.sessionProjections` 均正常
- 未验证：真实浏览器里点按钮 → 编辑 → 发送的完整链路（路由被 Connection 围栏保护，非认证请求一律 403，无法从外部调通）
