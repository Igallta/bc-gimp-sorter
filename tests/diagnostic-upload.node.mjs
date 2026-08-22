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
assert.equal(menuCommands.length, 2);
assert.match(menuCommands[0].label, /设置御坂诊断上传密钥/);
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

console.log("Misaka diagnostic upload bridge: PASS");
