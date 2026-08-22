#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const requests = [];
const store = new Map();
const queuedResponsePayloads = [];

const context = {
  console, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise,
  RegExp, URL, TextEncoder, structuredClone,
  setTimeout, clearTimeout,
  setInterval() { return 1; },
  clearInterval() {},
  queueMicrotask,
  navigator: {},
  document: { readyState: "complete" },
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  indexedDB: { open() { throw new Error("unexpected IndexedDB access"); } },
  Player: { MemberNumber: 194331, Name: "御搬", Nickname: "御搬", ChatSettings: {}, Appearance: [] },
  ChatRoomCharacter: [],
  CurrentScreen: "ChatRoom",
  Asset: [],
  AssetGroup: [],
  TranslationCache: {},
  InventoryGet() { return null; },
  CharacterRefresh() {},
  CharacterAppearanceBuildCanvas() {},
  ChatRoomCharacterUpdate() {},
  ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; },
  SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {},
  ElementValue() {},
  ChatRoomSendChat() {},
  __misakaHasSecret(key) { return key === "misaka_apikey"; },
  __misakaPrivateRequest(options) {
    const body = JSON.parse(String(options.data || "{}"));
    requests.push({ kind: options.kind, url: options.url, body });
    const output = JSON.stringify({
      protocol: "misaka.reply.v1",
      commands: [],
      action: "歪了歪头",
      speech: "可乐一般包含碳酸水、糖、焦糖色和咖啡因。",
    });
    const payload = queuedResponsePayloads.length > 0
      ? queuedResponsePayloads.shift()
      : {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                type: "function",
                function: { name: "emit_misaka_reply", arguments: output },
              }],
            },
          }],
          usage: { completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } },
        };
    return Promise.resolve({
      status: 200,
      responseText: JSON.stringify(payload),
      error: "",
    });
  },
};
context.window = context;
context.window.__misakaNextBootstrapOptions = { mode: "test" };
vm.runInNewContext(source, context, { filename: "misaka-chat.js" });

const hooks = context.__misakaPlanDebug;
assert.ok(hooks?.dryRunStructuredReplyForTest, "structured reply test hook must exist");
const result = await hooks.dryRunStructuredReplyForTest("chat", "御坂，可乐的配料表是什么");
assert.equal(result?.parsed?.protocol, "misaka.reply.v1");
assert.match(result?.parsed?.cleaned || "", /可乐/);
assert.equal(requests.length, 1);

const request = requests[0];
assert.equal(request.kind, "deepseek");
assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
assert.ok(Array.isArray(request.body.messages));
assert.equal(request.body.max_tokens, 2048);
assert.equal(request.body.thinking?.type, "disabled");
assert.equal(request.body.tools?.length, 1);
assert.equal(request.body.tools?.[0]?.type, "function");
assert.equal(request.body.tools?.[0]?.function?.name, "emit_misaka_reply");
assert.equal(request.body.tools?.[0]?.function?.strict, true);
assert.equal(request.body.tool_choice?.type, "function");
assert.equal(request.body.tool_choice?.function?.name, "emit_misaka_reply");
assert.equal(request.body.response_format, undefined);
assert.equal(request.body.text, undefined);

const schema = request.body.tools[0].function.parameters;
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.required, ["protocol", "commands", "action", "speech"]);
assert.deepEqual(schema.properties.protocol.enum, ["misaka.reply.v1"]);
assert.equal(schema.properties.action.pattern, "^[^\\r\\n*]*$");
assert.equal(schema.properties.speech.pattern, "^[^\\r\\n*]*$");
assert.match(schema.properties.action.description, /physical action/i);
assert.match(schema.properties.speech.description, /spoken dialogue/i);
const commandTypes = new Set(schema.properties.commands.items.anyOf.flatMap(variant =>
  variant.properties.type.enum || []));
assert.deepEqual(commandTypes, new Set([
  "move", "moveTo", "moveEdge", "itemadd", "itemdel", "itemdelall",
  "itemcolor", "itemset", "snapshotSave", "snapshotRestore", "copyRestraint",
  "emote", "bcequery",
]));
for (const variant of schema.properties.commands.items.anyOf) {
  assert.equal(variant.additionalProperties, false);
  assert.deepEqual(new Set(variant.required), new Set(Object.keys(variant.properties)),
    "DeepSeek strict tools require every object property to be required");
}

const diagnosticResult = await hooks.callGeneratedReplyForTest("chat", "请回复诊断测试");
assert.equal(diagnosticResult.exhausted, false);
assert.equal(diagnosticResult.attempts, 1);
assert.equal(requests.length, 2, "one generated reply must make exactly one model request");
assert.ok(diagnosticResult.diagnostics.some(item =>
  item.event === "response" && item.outcome === "content-extracted" && item.status === 200));
assert.ok(diagnosticResult.diagnostics.some(item =>
  item.event === "inspection" && item.outcome === "usable"));

queuedResponsePayloads.push(
  {
    choices: [{
      finish_reason: "stop",
      message: {
        content: "【action/Emote】歪了歪头\n\n【speech/Chat】这是普通文本，不是工具调用。",
        tool_calls: [],
      },
    }],
    usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } },
  },
);
const exhaustedResult = await hooks.callGeneratedReplyForTest("chat", "请制造一次非工具回复");
assert.equal(exhaustedResult.exhausted, true);
assert.equal(exhaustedResult.attempts, 1);
assert.equal(requests.length, 3, "an unusable response must not trigger another model request");
assert.equal(exhaustedResult.reason, "strict-tool-call-required");
assert.ok(exhaustedResult.diagnostics.some(item =>
  item.attempt === 1 && item.event === "response" && item.outcome === "unusable" &&
  item.finishReason === "stop" && item.toolCallCount === 0 &&
  /action\/Emote/.test(item.assistantTextPreview || "")));
assert.ok(exhaustedResult.diagnostics.some(item =>
  item.attempt === 1 && item.event === "inspection" && item.reason === "strict-tool-call-required"));

hooks.clearReplyFailureTraceForTest();
for (let index = 0; index < 22; index++) {
  hooks.persistReplyFailureBundleForTest({
    id: `fault-${index}`,
    stage: "llm:first",
    currentMessage: `问题 ${index} sk-secretvalue123456789`,
    context: hooks.buildReplyFailureContextForTest(Array.from({ length: 15 }, (_, messageIndex) => ({
      role: messageIndex % 2 ? "assistant" : "user",
      content: `上下文 ${messageIndex} Authorization: Bearer token-${messageIndex}`,
    }))),
    diagnostics: [{ event: "response", outcome: "unusable", status: 200, errorCode: "empty-content" }],
  });
}
const failureTrace = JSON.parse(JSON.stringify(hooks.inspectReplyFailureTraceForTest()));
assert.equal(failureTrace.length, 20, "reply failure telemetry must remain a bounded ring buffer");
assert.equal(failureTrace[0].id, "fault-2");
assert.equal(failureTrace.at(-1).context.length, 12, "only the most recent bounded context may be retained");
const exportedFailureText = JSON.stringify(failureTrace);
assert.doesNotMatch(exportedFailureText, /secretvalue|token-\d/);
assert.match(exportedFailureText, /REDACTED/);

context.__misakaTestLifecycle.dispose("responses-schema-suite-complete");
console.log("MisakaChat strict tool-call schema regression: PASS");
