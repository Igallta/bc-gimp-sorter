import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function makeContext() {
  const timers = [];
  const scripts = [];
  const elements = new Map();
  const gmStore = new Map();
  const context = {
    console: { log() {}, error() {} },
    CurrentScreen: "Login",
    Player: {
      MemberNumber: 194331,
      ID: 194331,
      ImmersionSettings: { ReturnToChatRoomAdmin: true },
    },
    bcModSdk: {},
    ChatSearchAutoJoinRoom() {},
    GM_xmlhttpRequest(options) {
      queueMicrotask(() => options.onload?.({ status: 200, responseText: '{"ok":true}' }));
      return { abort() {} };
    },
    GM_getValue(key, fallback = "") { return gmStore.has(key) ? gmStore.get(key) : fallback; },
    GM_setValue(key, value) { gmStore.set(key, value); },
    GM_deleteValue(key) { gmStore.delete(key); },
    GM_registerMenuCommand() {},
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    document: {
      readyState: "complete",
      head: {
        appendChild(script) {
          scripts.push(script);
          if (script.id) elements.set(script.id, script);
        },
      },
      createElement() {
        return {
          dataset: {},
          getAttribute(name) { return this[name] || ""; },
          remove() { if (this.id) elements.delete(this.id); },
        };
      },
      getElementById(id) { return elements.get(id) || null; },
    },
  };
  context.window = context;
  context.unsafeWindow = {};
  vm.createContext(context);
  return {
    context,
    scripts,
    runNextTimer() {
      const timer = timers.shift();
      assert.ok(timer, "expected a readiness retry timer");
      timer.fn();
    },
  };
}

function runLoader(relativePath) {
  const runtime = makeContext();
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  vm.runInContext(source, runtime.context, { filename: relativePath });
  return runtime;
}

const sorter = runLoader("../gimp-sorter.user.js");
assert.equal(sorter.scripts.length, 0, "GimpSorter must not inject on the login screen");
sorter.context.CurrentScreen = "ChatRoom";
sorter.runNextTimer();
assert.equal(sorter.scripts.length, 0, "GimpSorter must wait for the room message APIs");
sorter.context.ChatRoomMessage = () => {};
sorter.context.ChatRoomSendChat = () => {};
sorter.runNextTimer();
assert.equal(sorter.scripts.at(-1)?.id, "gimp-sorter-script");

const misaka = runLoader("../misaka-chat.user.js");
const pageBridge = misaka.context.unsafeWindow;
assert.equal(typeof pageBridge.__GM_getValue, "undefined", "page must not receive a raw secret reader");
assert.equal(pageBridge.__misakaSetSecret("misaka_apikey", "chat-secret"), true);
assert.equal(pageBridge.__misakaHasSecret("misaka_apikey"), true);
assert.equal(pageBridge.__misakaSetSecret("misaka_openrouter_key", "embedding-secret"), true);
assert.equal(pageBridge.__misakaHasSecret("misaka_openrouter_key"), true);
assert.equal(pageBridge.__misakaSetSecret("misaka_openai_key", "retired"), false);
assert.equal(pageBridge.__misakaSetSecret("misaka_diagnostics_upload_secret_v1", "blocked"), false);
assert.equal(pageBridge.__misakaHasSecret("misaka_diagnostics_upload_secret_v1"), false);
assert.equal(pageBridge.__misakaDiagnosticsConfigured(), false);
const privateResponse = await pageBridge.__misakaPrivateRequest({
  kind: "deepseek",
  url: "https://api.deepseek.com/beta/chat/completions",
  data: "{}",
});
assert.equal(privateResponse.status, 200);
const embeddingResponse = await pageBridge.__misakaPrivateRequest({
  kind: "openrouter-embedding",
  url: "https://openrouter.ai/api/v1/embeddings",
  data: "{}",
});
assert.equal(embeddingResponse.status, 200);
const blockedResponse = await pageBridge.__misakaPrivateRequest({
  kind: "deepseek",
  url: "https://example.invalid/steal",
  data: "{}",
});
assert.equal(blockedResponse.error, "request-not-allowed");
assert.equal(misaka.scripts.length, 0, "MisakaChat must not inject on the login screen");
misaka.context.CurrentScreen = "ChatRoom";
misaka.runNextTimer();
assert.equal(misaka.scripts.length, 0, "MisakaChat must wait for the room message APIs");
misaka.context.ChatRoomMessage = () => {};
misaka.context.ChatRoomSendChat = () => {};
misaka.runNextTimer();
assert.equal(misaka.scripts.at(-1)?.id, "misaka-persona-script");

console.log("loader chat readiness and private request bridge: PASS");
