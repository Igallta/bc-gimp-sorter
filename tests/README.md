# MisakaChat tests

## Regression model

回归按“越靠下越接近真实设备、外部状态越多”分成五层。不能用某一层通过来替代其他层：

| 层级 | 入口 | 真实网络 | 写入 | 证明范围 |
|---|---|---:|---|---|
| Node协议/安全 | `*.node.mjs` | 否 | 仅内存mock | Schema、队列、loader白名单、诊断签名、Voyage typed body、自检汇总 |
| 确定性浏览器 | `run-context-blue-node.mjs` 或browser hooks | 默认否 | test mode，不写生产IDB | 浏览器语义守卫、上下文、生命周期和规划边界 |
| raw-CDP兼容 | `run-*-cdp.mjs` | 部分用真实模型 | 只读debug hooks；禁止BC状态写入 | 当前BC runtime、目录、人物与模型集成 |
| iPad设备自检 | `/misaka selftest` | 是 | 仅一条临时IDB记录，读回后删除 | 私有Key、DeepSeek strict、Voyage query/document、WebKit存储与配额 |
| BC Agent影子 | Node桥接回归＋12–24小时观察 | 是 | 私有队列/只读decision；不写BC | 匿名化、事件配对、legacy/vNext延迟与回复质量 |

### 发布前本地基线

不需要浏览器或真实API的基线：

```bash
node --check misaka-chat.js
node --check misaka-chat.user.js
node --check misaka-persona.js
node tests/responses-schema.node.mjs
node tests/embedding-selftest.node.mjs
node tests/reply-queue.node.mjs
node tests/loader-readiness.node.mjs
node tests/loader-room-guard.node.mjs
node tests/diagnostic-upload.node.mjs
node tests/ipad-guard.node.mjs
node tests/gimp-sorter.node.mjs
node tests/run-context-blue-node.mjs
git diff --check
```

其中 `embedding-selftest.node.mjs` 必须锁定：

- 唯一provider为OpenRouter `voyageai/voyage-4-large`；
- 维度为1,024；
- query/document请求分别携带对应 `input_type`；
- 私有Key名为 `misaka_openrouter_key`；
- iPad语义记忆上限为1,000；
- 自检任一子项失败时总结果必须失败；
- Node test mode不得上传诊断包或触碰真实IndexedDB。

`diagnostic-upload.node.mjs` 还必须锁定影子桥的隐私边界：默认关闭、上传前匿名化MemberNumber/房间/消息标识和结构化显示名、失败时仅保留在Tampermonkey私有队列。`reply-queue.node.mjs` 必须证明影子事件在触发入口立即产生，即使现行回复仍处于busy/冷却；队列溢出和过期必须生成终止legacy receipt，不能留下永久待配对记录。

### iPad集成验收

在御坂实际运行的iPad房间内执行：

```text
/misaka diag
/misaka selftest
```

`selftest`不会发公屏或执行BC人物操作。它会真实调用一次DeepSeek strict reply、各一次Voyage query/document embedding，并在 `semantic_mem` 中写入一条带唯一标记的临时记录，读回后立即删除；随后读取 `navigator.storage.estimate()` 与 `persisted()`。详细脱敏报告保存在：

```js
window.__misakaSelftestReport
```

成功报告只保留在当前页面。若自检失败且已通过 `/misaka diagnostics` 配置私有诊断上传，失败摘要会复用现有 `misaka.reply-failure.v1` 签名上传队列；不引入未经服务端验证的新上传协议。验收要求8项检查全部通过；现存语义记忆只要包含非1,024维历史向量，`stored-vector-dimensions` 就会失败并要求先备份、重建。设备自检不验证真人指令语义、多步BC事务或回滚，这些仍由黑箱案例覆盖。

`deepseek-strict-tool.live.mjs` 是人工、显式的远程协议探针，不属于默认基线；只有在安全凭据文件已配置且确需验证DeepSeek服务端兼容性时运行。测试输出不得包含Key或模型正文。

### 真实影子观察验收

影子试验不替代上述四层。开启前必须确认：

- Worker `/health` 返回 `shadow: true`；
- `misaka-shadow-processor.service` 为active，且独立于Gateway unit；
- `misaka-spike` 没有channel binding，只允许BC实验工具；
- 本地processor secret为0600，Cloudflare只保存encrypted Secret；
- `/misaka shadow status` 显示上传密钥已配置、待上传为0。

观察期内候选只能写decision，不能发公屏、私聊或BC操作。结束后运行主机侧 `npm run shadow:report`，至少核对配对率、decision/legacy p50与p95、拒绝/澄清比例和人工回复质量；未配对、失败或重试耗尽的事件必须单列，不能从统计中静默删除。

## Browser runner connection

Ubuntu日常浏览器自动化使用OpenClaw的 `profile=user` existing-session入口。仓库中的 `run-*-cdp.mjs` 是兼容性raw-CDP runner，不再默认连接历史端口 `127.0.0.1:9222`；只有在明确存在支持 `/json` 与 `webSocketDebuggerUrl` 的CDP HTTP端点时才显式设置：

```bash
export MISAKA_CDP_URL=http://127.0.0.1:<port>
node tests/run-memory-blue-cdp.mjs --repeats=3
```

下文所有raw-CDP命令都假定该变量已显式导出。缺少 `MISAKA_CDP_URL` 时runner会在连接前退出，不会自行启动、接管或重启用户Chrome。

## Pending reply queue and native reply suite

`reply-queue.node.mjs` verifies the bounded five-message FIFO used while
MisakaChat is busy or cooling down. It covers BC `MsgId` deduplication,
five-minute expiry, overflow behavior, cross-user ordering and native
`Dictionary.ReplyId` output without writing to `InputChat`:

```bash
node tests/reply-queue.node.mjs
```

## Memory blue-light browser suite

`memory-blue.browser.js` exercises the real v2.10.17 planning and memory-recall
chain inside an active Bondage Club page. It uses the read-only hooks exposed at
`window.__misakaPlanDebug` and does not:

- send room messages;
- mutate character state;
- write profiles;
- write `semantic_mem` or `refined_mem`.

Run the script in the BC page, then execute:

```js
await window.__runMisakaMemoryBlue({ repeats: 3 })
```

The report is returned and retained at:

```js
window.__misakaMemoryBlueLastReport
```

With an explicitly configured compatible raw-CDP endpoint, the repository runner
hot-loads the local candidate and runs the suite without touching the page UI:

```bash
node tests/run-memory-blue-cdp.mjs --repeats=3
```

It exits non-zero when any case fails and prints the complete JSON report.
Individual cases can be repeated during diagnosis:

```bash
node tests/run-memory-blue-cdp.mjs --repeats=5 --ids=past-rikka-confirm
```

The suite measures:

- recall: past questions that correctly enter memory search;
- specificity: current/opinion/roleplay requests that correctly skip memory;
- answer accuracy: expected `supported`/`insufficient` status and essential
  facts in the final reply.

The cases deliberately include positive memories that still exist as raw
semantic evidence, unsupported causal questions, a fabricated event,
current-state questions and roleplay. Do not make a test expect `supported`
only because a fact once existed in `refined_mem`: refined facts are
intentionally bounded and may later be evicted. The suite is a stable baseline,
not a replacement for real room black-box testing.

## BC native Activity browser suite

`activity-blue.browser.js` verifies the real planner, the dynamic native
Activity catalog and execution-time permission revalidation. The suite only
uses `dryRunNativeActivity`; it never calls `ActivityRun`, sends a room message
or changes a character.

With a BC room open in the CDP browser:

```bash
node tests/run-activity-blue-cdp.mjs --repeats=3
```

The runner loads the local candidate in side-effect-free test mode and checks that:

- an ordinary physical interaction prefers `intent=activity` without requiring
  the user to say “BC/official/native”;
- the target, Activity and body group are preserved;
- explicit pretend/action-description requests and chat remain outside the
  native Activity branch;
- a forged or stale candidate cannot bypass the current BC allowed catalog.

Known v3.0.0 limitation: hair care requires `Hairbrush`, but the runtime does
not yet plan “equip Hairbrush, then run `TakeCare@ItemHead`” as a compound
Activity. The three hair-care cases remain explicit known failures when the
current catalog lacks `TakeCare`; `Pet@ItemHead` is not accepted as equivalent.

## Contextual sticker browser suite

`sticker-blue.browser.js` validates the four user-supplied production stickers,
their exact URLs and semantic selection boundaries. It also verifies that
ordinary chat, memory questions and native Activity requests do not select a
sticker.

```bash
node tests/run-sticker-blue-cdp.mjs --repeats=3
```

The runner temporarily enables the feature switch, loads the local candidate
in side-effect-free test mode and restores the user's saved switch afterwards.
Sending is dry-run only: it never calls `ChatRoomSendChat` and never posts an
image to the room.

Known v3.0.0 result: `tearful` can remain empty for the explicit sad/crying
positive case (0/3 in the release regression). The other three stickers,
catalog URLs and all no-sticker boundaries passed. Keep this case failing until
the behavior is fixed; it is a documented non-blocking release issue, not a
reason to weaken the expected result.

## Friendship browser suite

`friend-blue.browser.js` verifies explicit self-requests, third-party consent
boundaries, ordinary friendship sentiment, weak/strong evidence classification
and native dry-run behavior:

```bash
node tests/run-friend-blue-cdp.mjs --repeats=3
```

The suite never calls the mutating add-friend path and asserts that
`Player.FriendList` remains unchanged.

## Multi-speaker context browser suite

`context-blue.browser.js` covers quoted first-person requests, singular
operation schemas, recent conversational answers, explicit corrections and
named Activity requests that drift into clarification. It also locks down the
rapid-call boundary that previously dropped the reply-model call after the
planner consumed the 30th shared local quota slot. The burst uses an immediate
mock response, so all 31 calls must reach the transport and return non-empty;
an empty thinking response must remain a single request rather than triggering
an automatic model retry. The mock also verifies that structured replies use
DeepSeek's forced strict function call on the Beta Chat Completions endpoint;
ordinary assistant text is never accepted as a reply envelope:

```bash
node tests/run-context-blue-cdp.mjs --repeats=3
```

The suite only calls planning/debug hooks. It restores the page's recent
conversation context and never sends messages or mutates BC state.
When the planner API is unavailable, the deterministic JS guards can still be
verified without network calls:

```bash
node tests/run-context-blue-cdp.mjs --deterministic-only
```

The standalone transport/schema regression does not require a browser or make
network calls. It verifies the complete `misaka.reply.v1` command union and the
strict tool-call request/response adapter:

```bash
node tests/responses-schema.node.mjs
```

## Structured reply protocol suite

`run-reply-protocol-cdp.mjs` loads the local candidate in side-effect-free test
mode and asks the real reply model for chat, action+speech, roleplay and one
typed command envelope. The chat cases include known production structured-reply
failure fixtures and repeated invocation of the Misaka name.
It validates `misaka.reply.v1` parsing without calling `ChatRoomSendChat`,
`ActivityRun` or any character mutation path:

```bash
node tests/run-reply-protocol-cdp.mjs
```

## Planned item-operation browser suite

`run-item-operation-blue-cdp.mjs` drives the real planner and reply model for
natural device requests, then resolves every generated `itemadd` through the
same target-group resolver used by execution. It does not call the mutating
executor or send room messages.

The fixture currently requires Rin to be present and covers the colloquial,
Chinese asset-name and explicit BC asset-name forms of the pet-bed request:

```bash
node tests/run-item-operation-blue-cdp.mjs --repeats=3
```

It asserts that every request targets Rin, resolves to `PetBed`, survives the
plan boundary and maps semantic, native or omitted `part` values to the real
`ItemDevices` group.

## Fuzzy item semantics and mutation suite

`run-item-semantics-blue-cdp.mjs` builds cases from the live room roster,
Appearance state and BC asset catalog, then drives the real planner and reply
model without invoking any mutating executor. It covers:

- colloquial aliases, purpose descriptions and explicit Asset names;
- corrected, ambiguous and negated targets;
- semantic body parts and native BC groups;
- handheld, restraint and device additions;
- current-item removal, recoloring, property changes and device replacement.

Occupied or locked slots are not treated as valid add fixtures. Positive add
cases use a live character whose target group is free; mutation cases use a
currently worn, suitable item.

```bash
node tests/run-item-semantics-blue-cdp.mjs --repeats=2
```

Selected cases can be repeated independently:

```bash
node tests/run-item-semantics-blue-cdp.mjs \
  --repeats=3 \
  --ids=fuzzy-handheld-hairbrush,modify-current-vibrator-property
```

To repeat only selected cases while limiting model cost:

```bash
node tests/run-reply-protocol-cdp.mjs --ids=action-command-object
```

## Lifecycle and hot-reload suite

`run-lifecycle-blue-cdp.mjs` repeatedly loads the candidate in test mode and
asserts that every previous test lifecycle is disposed, no IndexedDB embedding
memory or runtime timer is created, and the active room runtime remains
untouched:

```bash
node tests/run-lifecycle-blue-cdp.mjs --iterations=10
```

The runner also forces garbage collection before and after the loop and fails
when retained heap growth exceeds 20 MiB. It does not send messages, install
socket hooks or mutate character state.
