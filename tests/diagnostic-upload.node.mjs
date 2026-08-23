#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.user.js", import.meta.url), "utf8");
const secret = "synthetic-upload-secret-123456";
const gmStore = new Map([["misaka_diagnostics_upload_secret_v1", secret]]);
const listeners = new Map();
const menuCommands = [];
const requests = [];
const timers = [];
let uploadSucceeds = true;

const document = {
  body: { append() {} },
  visibilityState: "visible",
  addEventListener(type, callback) { listeners.set(type, callback); },
  dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
  getElementById() { return null; },
  createElement() { return { dataset: {}, style: {}, append() {}, focus() {}, remove() {} }; },
  head: { appendChild() {} },
};

const context = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto,
  TextEncoder,
  Uint8Array,
  Date,
  JSON,
  Math,
  Number,
  String,
  Set,
  Promise,
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  document,
  CurrentScreen: "Login",
  navigator: { onLine: true },
  Player: { MemberNumber: 194331, ImmersionSettings: { ReturnToChatRoomAdmin: true } },
  ChatSearchAutoJoinRoom() {},
  setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  GM_getValue(key, fallback) { return gmStore.has(key) ? gmStore.get(key) : fallback; },
  GM_setValue(key, value) { gmStore.set(key, structuredClone(value)); },
  GM_deleteValue(key) { gmStore.delete(key); },
  GM_registerMenuCommand(label, callback) { menuCommands.push({ label, callback }); },
  GM_xmlhttpRequest(options) {
    requests.push(options);
    queueMicrotask(() => {
      if (uploadSucceeds) options.onload?.({ status: 200, responseText: '{"ok":true,"issueNumber":1}' });
      else options.onerror?.({});
    });
    return { abort() {} };
  },
};
context.window = context;
context.unsafeWindow = {};
vm.createContext(context);
vm.runInContext(source, context, { filename: "misaka-chat.user.js" });

assert.equal(typeof context.unsafeWindow.__GM_getValue, "undefined",
  "no raw secret reader may be exposed to the page runtime");
assert.equal(context.unsafeWindow.__misakaHasSecret("misaka_diagnostics_upload_secret_v1"), false,
  "diagnostic secret existence must not be exposed to the page runtime");
assert.equal(context.unsafeWindow.__misakaDiagnosticsConfigured(), true,
  "page runtime may query only whether private diagnostic upload is configured");
assert.equal(menuCommands.length, 5);
assert.match(menuCommands[0].label, /设置御坂诊断上传密钥/);
assert.match(menuCommands.at(-1).label, /清除御坂影子本地数据/);
assert.match(source, /@connect\s+misaka-diagnostics\.misaka-diagnostics\.workers\.dev/);

const envelope = {
  protocol: "misaka.upload.v1",
  client: { version: "test", platform: "browser" },
  bundle: { protocol: "misaka.reply-failure.v1", stage: "llm:first" },
};
document.dispatchEvent(new context.CustomEvent("misaka-diagnostics-upload-v1", { detail: envelope }));
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(requests.length, 1, "one failure event should make one upload request");
assert.equal(requests[0].url, "https://misaka-diagnostics.misaka-diagnostics.workers.dev/v1/reply-failures");
assert.equal(requests[0].data, JSON.stringify(envelope));
const timestamp = requests[0].headers["X-Misaka-Timestamp"];
const expected = createHmac("sha256", secret).update(`${timestamp}.${requests[0].data}`).digest("hex");
assert.equal(requests[0].headers["X-Misaka-Signature"], `v1=${expected}`);
assert.deepEqual(gmStore.get("misaka_diagnostics_pending_v1"), [], "successful upload should drain the queue");

uploadSucceeds = false;
document.dispatchEvent(new context.CustomEvent("misaka-diagnostics-upload-v1", { detail: envelope }));
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(gmStore.get("misaka_diagnostics_pending_v1").length, 1,
  "failed upload should remain in the private pending queue");

uploadSucceeds = true;
const shadowStatus = context.unsafeWindow.__misakaShadowSetEnabled(true);
assert.deepEqual(
  JSON.parse(JSON.stringify(shadowStatus)),
  { enabled: true, configured: true, pending: 0 },
);
await new Promise(resolve => setTimeout(resolve, 25));
const heartbeatRequest = requests.findLast(request => request.url.endsWith("/v1/shadow/heartbeat"));
assert.ok(heartbeatRequest, "enabling shadow mode should send an immediate heartbeat");
const heartbeatUpload = JSON.parse(heartbeatRequest.data);
assert.equal(heartbeatUpload.kind, "heartbeat");
assert.equal(heartbeatUpload.heartbeat.protocol, "misaka.shadow-heartbeat.v1");
assert.equal(heartbeatUpload.heartbeat.visibility, "visible");
assert.equal(heartbeatUpload.heartbeat.online, true);
assert.equal(heartbeatUpload.heartbeat.pending, 0);
const shadowEvent = {
  protocol: "misaka.shadow-event.v1",
  eventId: "shadow-test-1",
  createdAt: Date.now(),
  receivedAt: Date.now() - 20,
  roomEpoch: "private-room-name",
  sender: { memberNumber: 1001, name: "铃" },
  message: { type: "Chat", text: "御坂，晚上好", replyId: "private-message-id" },
  context: [{ memberNumber: 1002, senderName: "咲", type: "Chat", text: "晚上好", time: Date.now() }],
  projection: {
    memberCount: 2,
    members: [
      { memberNumber: 1001, name: "铃", position: 0, appearance: [] },
      { memberNumber: 1002, name: "咲", position: 1, appearance: [] },
    ],
  },
};
document.dispatchEvent(new context.CustomEvent("misaka-shadow-event-v1", { detail: shadowEvent }));
await new Promise(resolve => setTimeout(resolve, 25));
const shadowRequest = requests.findLast(request => request.url.endsWith("/v1/shadow/events"));
assert.equal(shadowRequest.url, "https://misaka-diagnostics.misaka-diagnostics.workers.dev/v1/shadow/events");
const shadowUpload = JSON.parse(shadowRequest.data);
assert.equal(shadowUpload.protocol, "misaka.shadow-upload.v1");
assert.match(shadowUpload.event.roomEpoch, /^room-[a-f0-9]{24}$/);
assert.match(shadowUpload.event.sender.memberId, /^member-[a-f0-9]{24}$/);
assert.equal(shadowUpload.event.sender.name, shadowUpload.event.sender.memberId);
assert.equal(shadowUpload.event.sender.memberNumber, undefined);
assert.equal(shadowUpload.event.context[0].senderName, shadowUpload.event.context[0].memberId);
assert.equal(shadowUpload.event.context[0].memberNumber, undefined);
assert.equal(shadowUpload.event.projection.members[0].name, shadowUpload.event.projection.members[0].memberId);
assert.equal(shadowUpload.event.projection.members[0].memberNumber, undefined);
assert.notEqual(shadowUpload.event.message.replyId, "private-message-id");
assert.doesNotMatch(JSON.stringify(shadowUpload), /private-room-name|private-message-id|"memberNumber"|"铃"|"咲"/);
assert.deepEqual(gmStore.get("misaka_shadow_pending_v1"), [], "successful shadow upload should drain the queue");

gmStore.set("misaka_shadow_pending_v1", [{ synthetic: true }]);
menuCommands.at(-1).callback();
assert.equal(gmStore.get("misaka_shadow_enabled_v1"), false);
assert.equal(gmStore.has("misaka_shadow_pending_v1"), false);
assert.equal(gmStore.has("misaka_shadow_installation_v1"), false);
assert.equal(gmStore.has("misaka_shadow_pseudonym_salt_v1"), false);

console.log("Misaka diagnostic upload bridge: PASS");
