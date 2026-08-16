import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-ipad-guard.js", import.meta.url), "utf8");
const store = new Map();
let reloadCount = 0;
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
  ChatRoomMessage() {},
  ElementValue() { return ""; },
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
assert.equal(guard.version, "0.1.0");
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

assert.match(source, /location\.reload\(\)/, "recycle must reload the current BC page");
assert.doesNotMatch(source, /ipad-recycle\.html/, "recycle must not navigate to a cross-origin trampoline");
assert.doesNotMatch(source, /location\.replace\(/, "recycle must preserve the proven same-origin login flow");

console.log("iPad guard tests: 15/15 passed");
