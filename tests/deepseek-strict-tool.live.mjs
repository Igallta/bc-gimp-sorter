#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  Asset: [], AssetGroup: [], TranslationCache: {},
  InventoryGet() { return null; }, CharacterRefresh() {}, CharacterAppearanceBuildCanvas() {},
  ChatRoomCharacterUpdate() {}, ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; }, SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {}, ElementValue() {}, ChatRoomSendChat() {},
  __misakaHasSecret(key) { return key === "misaka_apikey"; },
  __misakaPrivateRequest(options) {
    requests.push({ url: options.url, body: JSON.parse(String(options.data || "{}")) });
    const output = JSON.stringify({
      protocol: "misaka.reply.v1", commands: [], action: "歪了歪头", speech: "测试。",
    });
    return Promise.resolve({
      status: 200,
      responseText: JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: { content: null, tool_calls: [{
            type: "function",
            function: { name: "emit_misaka_reply", arguments: output },
          }] },
        }],
      }),
      error: "",
    });
  },
};
context.window = context;
context.window.__misakaNextBootstrapOptions = { mode: "test" };
vm.runInNewContext(source, context, { filename: "misaka-chat.js" });

await context.__misakaPlanDebug.dryRunStructuredReplyForTest("chat", "请简短回复一次协议探针");
if (requests.length !== 1) throw new Error(`expected one captured request, got ${requests.length}`);

const keyFile = process.env.MISAKA_KEY_FILE || path.join(os.homedir(), ".openclaw", "misaka-keys.json");
const secrets = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const apiKey = String(secrets.misaka_apikey || "").trim();
if (!apiKey) throw new Error("missing misaka_apikey in secure key file");

const request = requests[0];
const response = await fetch(request.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(request.body),
  signal: AbortSignal.timeout(180_000),
});
const payload = await response.json().catch(() => ({}));
const choice = payload?.choices?.[0] || null;
const call = choice?.message?.tool_calls?.[0] || null;
let args = null;
try { args = JSON.parse(String(call?.function?.arguments || "")); } catch {}

const result = {
  httpStatus: response.status,
  apiErrorCode: payload?.error?.code || null,
  finishReason: choice?.finish_reason || null,
  toolName: call?.function?.name || null,
  argumentsAreJson: Boolean(args && typeof args === "object" && !Array.isArray(args)),
  protocolValid: args?.protocol === "misaka.reply.v1",
  commandsAreArray: Array.isArray(args?.commands),
  actionIsString: typeof args?.action === "string",
  speechIsString: typeof args?.speech === "string",
};
console.log(JSON.stringify(result, null, 2));
if (!response.ok || result.toolName !== "emit_misaka_reply" || !result.protocolValid ||
    !result.commandsAreArray || !result.actionIsString || !result.speechIsString) {
  process.exitCode = 1;
}
