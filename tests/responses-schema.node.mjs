#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const requests = [];
const store = new Map();

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
  __GM_getValue(key) { return key === "misaka_apikey" ? "test-only-key" : ""; },
  __GM_xmlhttpRequest(options) {
    const body = JSON.parse(String(options.data || "{}"));
    requests.push({ url: options.url, body });
    const output = JSON.stringify({
      protocol: "misaka.reply.v1",
      commands: [],
      action: "歪了歪头",
      speech: "可乐一般包含碳酸水、糖、焦糖色和咖啡因。",
    });
    queueMicrotask(() => options.onload?.({
      status: 200,
      responseText: JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: output }],
        }],
        usage: { output_tokens: 80, output_tokens_details: { reasoning_tokens: 20 } },
      }),
    }));
    return { abort() {} };
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
assert.equal(request.url, "https://api.deepseek.com/responses");
assert.ok(Array.isArray(request.body.input));
assert.equal(request.body.max_output_tokens, 2048);
assert.equal(request.body.reasoning?.effort, "high");
assert.equal(request.body.text?.format?.type, "json_schema");
assert.equal(request.body.text?.format?.strict, true);
assert.equal(request.body.text?.format?.name, "misaka_reply");
assert.equal(request.body.response_format, undefined);

const schema = request.body.text.format.schema;
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.required, ["protocol", "commands", "action", "speech"]);
assert.deepEqual(schema.properties.protocol.enum, ["misaka.reply.v1"]);
const commandTypes = new Set(schema.properties.commands.items.anyOf.flatMap(variant =>
  variant.properties.type.enum || []));
assert.deepEqual(commandTypes, new Set([
  "move", "moveTo", "moveEdge", "itemadd", "itemdel", "itemdelall",
  "itemcolor", "itemset", "snapshotSave", "snapshotRestore", "copyRestraint",
  "emote", "bcequery", "memsearch",
]));
for (const variant of schema.properties.commands.items.anyOf) {
  assert.equal(variant.additionalProperties, false);
  assert.ok(Array.isArray(variant.required) && variant.required.includes("type"));
}

context.__misakaTestLifecycle.dispose("responses-schema-suite-complete");
console.log("MisakaChat Responses json_schema regression: PASS");
