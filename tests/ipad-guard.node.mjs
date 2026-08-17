import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-ipad-guard.js", import.meta.url), "utf8");
const misakaChatSource = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const loaderSource = fs.readFileSync(new URL("../misaka-ipad-guard.user.js", import.meta.url), "utf8");
const recycleHTML = fs.readFileSync(new URL("../ipad-recycle.html", import.meta.url), "utf8");

function runtimeContext() {
  const store = new Map();
  const localMessages = [];
  const hooks = new Map();
  const documentEvents = [];
  let replacedWith = "";
  let originalSendCount = 0;
  let inputValue = "";
  const context = {
    console, Date, JSON, Math, Number, String, URL, encodeURIComponent,
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval: () => {},
    navigator: { userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", maxTouchPoints: 5, onLine: true },
    location: {
      href: "https://www.bondage-europe.com/R130/BondageClub/",
      hostname: "www.bondage-europe.com",
      pathname: "/R130/BondageClub/",
      replace(value) { replacedWith = String(value); },
    },
    Event: class Event { constructor(type) { this.type = type; } },
    document: {
      hidden: false,
      visibilityState: "visible",
      addEventListener() {},
      dispatchEvent(event) { documentEvents.push(event.type); return true; },
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
  return { context, store, localMessages, hooks, documentEvents, get replacedWith() { return replacedWith; }, get originalSendCount() { return originalSendCount; }, set inputValue(value) { inputValue = value; }, get inputValue() { return inputValue; } };
}

const runtime = runtimeContext();
const guard = runtime.context.window.__MisakaIPadGuard;
const test = runtime.context.window.__MisakaIPadGuardTestHooks;
assert.ok(guard, "guard runtime should initialize for Misaka account");
assert.equal(guard.version, "0.2.3");
const guardLocalColor = source.match(/<font color="(#[0-9A-Fa-f]{6})">\[iPadGuard\]/)?.[1];
const misakaLocalColor = misakaChatSource.match(/<font color="(#[0-9A-Fa-f]{6})">\[MisakaChat\]/)?.[1];
assert.equal(guardLocalColor, misakaLocalColor, "Guard local messages must use MisakaChat's exact color");
assert.equal(guard.config.enabled, false, "auto recycle must be opt-in");
assert.deepEqual(
  JSON.parse(JSON.stringify(test.normalizeConfig({ enabled: true, intervalMinutes: 2, quietSeconds: 9999 }))),
  { enabled: true, intervalMinutes: 15, quietSeconds: 600, maxDeferMinutes: 10 },
  "config values should be clamped",
);
assert.equal(guard.handleCommand("hello"), false);
assert.equal(guard.handleCommand("/ipadguard on"), true);
assert.equal(guard.config.enabled, true);
assert.equal(JSON.parse(runtime.store.get("misaka_ipad_guard_config_v1")).enabled, true);

guard.recycle("test");
assert.match(runtime.replacedWith, /^https:\/\/igallta\.github\.io\/bc-gimp-sorter\/ipad-recycle\.html#return=/);
assert.match(decodeURIComponent(runtime.replacedWith), /https:\/\/www\.bondage-europe\.com\/R130\/BondageClub\//);
const pending = JSON.parse(runtime.store.get("misaka_ipad_guard_pending_v1"));
assert.equal(pending.reason, "test");
assert.ok(runtime.hooks.has("ChatRoomMessage"));
assert.ok(runtime.hooks.has("ChatRoomSendChat"));

runtime.inputValue = "/ipadguard status";
runtime.context.window.ChatRoomSendChat("not-the-command");
assert.equal(runtime.originalSendCount, 0, "mobile command must be consumed before BC");
assert.equal(runtime.inputValue, "", "consumed command must clear InputChat");
assert.match(runtime.localMessages.at(-1)?.Content || "", /v0\.2\.3/);
assert.equal(guard.handleCommand("/ipadguard login"), true);
assert.match(runtime.localMessages.at(-1)?.Content || "", /WCE.*MSK002.*194331/);
assert.deepEqual(runtime.documentEvents, []);
runtime.inputValue = "普通聊天";
runtime.context.window.ChatRoomSendChat();
assert.equal(runtime.originalSendCount, 1, "ordinary chat must continue to BC");
assert.match(source, /location\.replace\(target\)/, "recycle must navigate to the cross-origin trampoline");
assert.doesNotMatch(source, /location\.reload\(\)/, "recycle must not use same-origin reload");

function loaderContext({ screen = "Login" } = {}) {
  const scheduled = [];
  let appendedScript = null;
  const page = {
    CurrentModule: screen === "Login" ? "Online" : "Character",
    CurrentScreen: screen,
    Player: screen === "ChatRoom" ? { MemberNumber: 194331 } : null,
  };
  const context = {
    console, Date, JSON, Math, Number, String, URL,
    unsafeWindow: page,
    window: {},
    setTimeout(callback, delay = 0) { scheduled.push({ callback, delay }); return scheduled.length; },
    document: {
      getElementById(id) {
        if (id === "misaka-ipad-guard-script") return appendedScript;
        return null;
      },
      createElement(tag) {
        if (tag === "script") return { dataset: {}, remove() { appendedScript = null; } };
        return {};
      },
      head: { appendChild(script) { appendedScript = script; } },
    },
  };
  vm.runInNewContext(loaderSource, context, { filename: "misaka-ipad-guard.user.js" });
  return {
    context, page, scheduled,
    get appendedScript() { return appendedScript; },
  };
}

function runScheduled(loader, delay) {
  const index = loader.scheduled.findIndex((entry) => entry.delay === delay);
  assert.notEqual(index, -1, `expected scheduled callback after ${delay} ms`);
  const [{ callback }] = loader.scheduled.splice(index, 1);
  callback();
}

const loader = loaderContext();
assert.ok(loader.appendedScript, "page runtime must load on the login screen");
assert.equal(loader.appendedScript.dataset.mode, "login");
assert.match(loader.appendedScript.src || "", /v=0\.2\.3/);
loader.page.__MisakaIPadGuardLoginRecovery = { version: "0.2.3" };
loader.appendedScript.onload();
assert.doesNotMatch(loaderSource, /GM_(?:get|set|delete)Value|InputPassword|credentials/i, "Guard must not access or store WCE credentials");

loader.page.CurrentModule = "Online";
loader.page.CurrentScreen = "ChatRoom";
loader.page.Player = { MemberNumber: 194331 };
loader.page.bcModSdk = {};
loader.page.ChatRoomSendChat = () => {};
loader.page.ChatRoomMessage = () => {};
runScheduled(loader, 500);
assert.ok(loader.appendedScript, "runtime must load after native login reaches ChatRoom");
assert.equal(loader.appendedScript.dataset.mode, "chatroom");
assert.match(loader.appendedScript.src || "", /v=0\.2\.3/);

function loginRuntimeContext(label = "MSK002") {
  const store = new Map();
  const intervals = [];
  const timeouts = [];
  const alerts = [];
  const drawnButtons = [];
  let quickLoginClicks = 0;
  const originalDrawButton = function (x, y, width, height, text) {
    drawnButtons.push({ x, y, width, height, text: String(text) });
  };
  const context = {
    console, Date, JSON, Math, Number, String, URL, Set,
    navigator: { userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", maxTouchPoints: 5, onLine: true },
    location: {
      href: "https://www.bondage-europe.com/R130/BondageClub/",
      hostname: "www.bondage-europe.com",
      pathname: "/R130/BondageClub/",
    },
    document: { hidden: false },
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); },
    },
    alert(message) { alerts.push(String(message)); },
    Event: class Event { constructor(type) { this.type = type; } },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval() {},
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; },
    CurrentModule: "Online",
    CurrentScreen: "Login",
    CurrentScreenFunctions: {
      Click() {
        if (context.MouseX >= 10 && context.MouseX <= 360 && context.MouseY >= 60 && context.MouseY <= 120) {
          quickLoginClicks += 1;
        }
      },
    },
    Player: null,
    LoginSubmitted: false,
    LoginErrorMessage: "",
    MouseX: 900,
    MouseY: 700,
    DrawButton: originalDrawButton,
    LoginClick() { throw new Error("global LoginClick fallback should not be used when CurrentScreenFunctions.Click exists"); },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "misaka-ipad-guard.js" });
  context.DrawButton(10, 60, 350, 60, label, "White");
  const loginTick = intervals.find((entry) => entry.delay === 100);
  assert.ok(loginTick, "login recovery must poll in the page runtime");
  loginTick.callback();
  const click = timeouts.find((entry) => entry.delay === 250);
  if (click) click.callback();
  return {
    context, store, intervals, timeouts, alerts, drawnButtons, originalDrawButton,
    get quickLoginClicks() { return quickLoginClicks; },
  };
}

const loginRuntime = loginRuntimeContext();
assert.equal(loginRuntime.quickLoginClicks, 1, "page runtime must click the exact WCE quick-login button once");
assert.equal(loginRuntime.context.MouseX, 900, "synthetic click must restore the previous mouse X coordinate");
assert.equal(loginRuntime.context.MouseY, 700, "synthetic click must restore the previous mouse Y coordinate");
assert.equal(loginRuntime.context.DrawButton, loginRuntime.originalDrawButton, "DrawButton capture must be removed after locating the target");
assert.equal(loginRuntime.context.__MisakaIPadGuard, undefined, "chat-room runtime must not initialize on login");
assert.equal(loginRuntime.context.__MisakaIPadGuardLoginRecovery.version, "0.2.3");
assert.doesNotMatch(source, /GM_(?:get|set|delete)Value|InputPassword|credentials/i, "Guard runtime must not access or store WCE credentials");

assert.equal(loginRuntimeContext("MSK003").quickLoginClicks, 0, "page runtime must not click another saved WCE account");
assert.equal(loginRuntimeContext("msk002").quickLoginClicks, 1, "WCE login-name matching may ignore display case");
assert.equal(loginRuntimeContext("#194331").quickLoginClicks, 1, "WCE's optional exact member ID remains compatible");

const scriptMatch = recycleHTML.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "trampoline must contain its inline return script");
function runTrampoline(returnUrl) {
  let replacedWith = "";
  let scheduled = null;
  const status = { textContent: "" };
  const context = {
    URL, URLSearchParams,
    location: {
      hash: `#return=${encodeURIComponent(returnUrl)}`,
      pathname: "/bc-gimp-sorter/ipad-recycle.html",
      search: "",
      replace(value) { replacedWith = String(value); },
    },
    history: { replaceState() {} },
    document: { getElementById() { return status; } },
    setTimeout(callback) { scheduled = callback; return 1; },
  };
  vm.runInNewContext(scriptMatch[1], context, { filename: "ipad-recycle.html" });
  if (scheduled) scheduled();
  return { replacedWith, status: status.textContent };
}

const validReturn = runTrampoline("https://www.bondage-europe.com/R130/BondageClub/");
assert.equal(validReturn.replacedWith, "https://www.bondage-europe.com/R130/BondageClub/");
const invalidReturn = runTrampoline("https://evil.example/steal");
assert.equal(invalidReturn.replacedWith, "", "trampoline must reject non-BC return URLs");
assert.match(invalidReturn.status, /无效/);

console.log("iPad guard v0.2.3 tests passed");
