import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-ipad-guard.js", import.meta.url), "utf8");
const loaderSource = fs.readFileSync(new URL("../misaka-ipad-guard.user.js", import.meta.url), "utf8");
const store = new Map();
let reloadCount = 0;
let originalSendCount = 0;
let inputValue = "";
const localMessages = [];
const hooks = new Map();

const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  String,
  URL,
  encodeURIComponent,
  setTimeout: () => 1,
  setInterval: () => 1,
  clearInterval: () => {},
  navigator: { userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", maxTouchPoints: 5, onLine: true },
  location: {
    href: "https://bondage-europe.com/R130/BondageClub",
    hostname: "bondage-europe.com",
    pathname: "/R130/BondageClub",
    reload() { reloadCount += 1; },
  },
  document: {
    hidden: false,
    visibilityState: "visible",
    addEventListener() {},
    getElementById() { return null; },
  },
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  Player: { MemberNumber: 194331 },
  CurrentScreen: "ChatRoom",
  ServerSocket: { connected: true, disconnected: false },
  ChatRoomMessage(data) { localMessages.push(data); },
  ChatRoomSendChat() { originalSendCount += 1; },
  ElementValue(id, value) {
    if (id !== "InputChat") return "";
    if (arguments.length > 1) inputValue = String(value || "");
    return inputValue;
  },
  bcModSdk: {
    getModsInfo() { return []; },
    registerMod() {
      return { hookFunction(name, _priority, callback) { hooks.set(name, callback); } };
    },
  },
};
context.window = context;
context.window.addEventListener = () => {};

vm.runInNewContext(source, context, { filename: "misaka-ipad-guard.js" });

const guard = context.window.__MisakaIPadGuard;
const test = context.window.__MisakaIPadGuardTestHooks;
assert.ok(guard, "guard runtime should initialize for Misaka account");
assert.equal(guard.version, "0.1.3");
assert.equal(guard.config.enabled, false, "auto recycle must be opt-in");

assert.deepEqual(
  JSON.parse(JSON.stringify(test.normalizeConfig({ enabled: true, intervalMinutes: 2, quietSeconds: 9999 }))),
  { enabled: true, intervalMinutes: 15, quietSeconds: 600, maxDeferMinutes: 10 },
  "config values should be clamped",
);

assert.equal(guard.handleCommand("hello"), false);
assert.equal(guard.handleCommand("/ipadguard on"), true);
assert.equal(guard.config.enabled, true);
assert.equal(JSON.parse(store.get("misaka_ipad_guard_config_v1")).enabled, true);

guard.recycle("test");
assert.equal(reloadCount, 1, "recycle must perform one same-origin full reload");
const pending = JSON.parse(store.get("misaka_ipad_guard_pending_v1"));
assert.equal(pending.reason, "test");

assert.ok(hooks.has("ChatRoomMessage"));
assert.ok(hooks.has("ChatRoomSendChat"));

assert.equal(typeof context.window.ChatRoomSendChat, "function");
inputValue = "/ipadguard status";
context.window.ChatRoomSendChat("not-the-command");
assert.equal(originalSendCount, 0, "direct wrapper must consume a mobile command before BC");
assert.equal(inputValue, "", "consumed command must clear InputChat");
assert.match(localMessages.at(-1)?.Content || "", /v0\.1\.3/, "status command must produce a local reply");

inputValue = "普通聊天";
context.window.ChatRoomSendChat();
assert.equal(originalSendCount, 1, "ordinary chat must continue to BC");

assert.match(source, /location\.reload\(\)/, "recycle must reload the current BC page");
assert.doesNotMatch(source, /ipad-recycle\.html/, "recycle must not navigate to a cross-origin trampoline");
assert.doesNotMatch(source, /location\.replace\(/, "recycle must preserve the proven same-origin login flow");

let scheduledLoaderRetry = null;
let appendedLoaderScript = null;
const loaderContext = {
  console,
  setTimeout(fn) { scheduledLoaderRetry = fn; return 1; },
  CurrentScreen: "Login",
  Player: { MemberNumber: 194331 },
  bcModSdk: {},
  ChatRoomSendChat() {},
  ChatRoomMessage() {},
  document: {
    getElementById() { return null; },
    createElement() {
      return {
        dataset: {},
        remove() { appendedLoaderScript = null; },
      };
    },
    head: {
      appendChild(script) { appendedLoaderScript = script; },
    },
  },
};
loaderContext.window = loaderContext;
vm.runInNewContext(loaderSource, loaderContext, { filename: "misaka-ipad-guard.user.js" });
assert.equal(appendedLoaderScript, null, "loader must not inject before ChatRoom is ready");
assert.equal(typeof scheduledLoaderRetry, "function", "loader must keep waiting for ChatRoom");
loaderContext.CurrentScreen = "ChatRoom";
scheduledLoaderRetry();
assert.ok(appendedLoaderScript, "loader must inject after entering ChatRoom");
assert.match(appendedLoaderScript.src || "", /v=0\.1\.3/, "loader must request the current runtime version");
assert.match(appendedLoaderScript.src || "", /raw\.githack\.com\/Igallta\/bc-gimp-sorter\/0887205\//, "loader must pin the released runtime revision");
loaderContext.window.__MisakaIPadGuard = { version: "0.1.3" };
appendedLoaderScript.onload();

console.log("iPad guard tests: 24/24 passed");
