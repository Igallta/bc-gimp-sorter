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
  return {
    context, store, localMessages, hooks, documentEvents,
    get replacedWith() { return replacedWith; },
    get originalSendCount() { return originalSendCount; },
    set inputValue(value) { inputValue = value; },
    get inputValue() { return inputValue; },
  };
}

const runtime = runtimeContext();
const guard = runtime.context.window.__MisakaIPadGuard;
const test = runtime.context.window.__MisakaIPadGuardTestHooks;
assert.ok(guard, "guard runtime should initialize for Misaka account");
assert.equal(guard.version, "0.3.1");
const guardLocalColor = source.match(/<font color="(#[0-9A-Fa-f]{6})">\[iPadGuard\]/)?.[1];
const misakaLocalColor = misakaChatSource.match(/<font color="(#[0-9A-Fa-f]{6})">\[MisakaChat\]/)?.[1];
assert.equal(guardLocalColor, misakaLocalColor, "Guard local messages must use MisakaChat's exact color");
assert.equal(guard.config.enabled, false, "auto recycle must be opt-in");
assert.deepEqual(
  JSON.parse(JSON.stringify(test.normalizeConfig({ enabled: true, intervalMinutes: 2, quietSeconds: 9999 }))),
  { enabled: true, intervalMinutes: 15, quietSeconds: 600, maxDeferMinutes: 10 },
);
assert.equal(guard.handleCommand("hello"), false);
assert.equal(guard.handleCommand("/ipadguard on"), true);
assert.equal(guard.config.enabled, true);
assert.equal(JSON.parse(runtime.store.get("misaka_ipad_guard_config_v1")).enabled, true);

guard.recycle("test");
assert.match(runtime.replacedWith, /^https:\/\/igallta\.github\.io\/bc-gimp-sorter\/ipad-recycle\.html#return=/);
assert.match(decodeURIComponent(runtime.replacedWith), /https:\/\/www\.bondage-europe\.com\/R130\/BondageClub\//);
assert.equal(JSON.parse(runtime.store.get("misaka_ipad_guard_pending_v1")).reason, "test");
assert.ok(runtime.hooks.has("ChatRoomMessage"));
assert.ok(runtime.hooks.has("ChatRoomSendChat"));

runtime.inputValue = "/ipadguard status";
runtime.context.window.ChatRoomSendChat("not-the-command");
assert.equal(runtime.originalSendCount, 0, "mobile command must be consumed before BC");
assert.equal(runtime.inputValue, "", "consumed command must clear InputChat");
assert.match(runtime.localMessages.at(-1)?.Content || "", /v0\.3\.1/);
assert.equal(guard.handleCommand("/ipadguard login"), true);
assert.ok(runtime.documentEvents.includes("misaka-ipad-guard-open-login-config"));
assert.match(runtime.localMessages.at(-1)?.Content || "", /MSK002.*194331/);
runtime.inputValue = "普通聊天";
runtime.context.window.ChatRoomSendChat();
assert.equal(runtime.originalSendCount, 1, "ordinary chat must continue to BC");
assert.match(source, /location\.replace\(target\)/, "recycle must use the cross-origin trampoline");
assert.doesNotMatch(source, /location\.reload\(\)/);

function makeElementFactory(elements) {
  return function makeElement(tag) {
    const listeners = new Map();
    const element = {
      tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [], textContent: "", value: "",
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); return child; },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
      remove() { if (this.id) elements.delete(this.id); },
      focus() {},
    };
    Object.defineProperty(element, "id", {
      get() { return this._id || ""; },
      set(value) { this._id = String(value); if (this._id) elements.set(this._id, this); },
    });
    return element;
  };
}

function loaderContext({ screen = "Login", password = "", enabled = false, fail = false, connected = true, memberNumber = 194331 } = {}) {
  const scheduled = [];
  const gmStore = new Map([
    ["misaka_ipad_guard_login_enabled_v1", enabled],
    ["misaka_ipad_guard_login_password_v1", password],
  ]);
  const menuCommands = [];
  const loginCalls = [];
  const elements = new Map();
  const makeElement = makeElementFactory(elements);
  class MockInput {
    constructor(id) { this.id = id; this._value = ""; this.events = []; elements.set(id, this); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    dispatchEvent(event) { this.events.push(event.type); return true; }
  }
  const body = makeElement("body");
  const nameInput = new MockInput("InputName");
  const passwordInput = new MockInput("InputPassword");
  let appendedScript = null;
  const page = {
    CurrentModule: screen === "Login" ? "Online" : "Character",
    CurrentScreen: screen,
    Player: screen === "ChatRoom" ? { MemberNumber: memberNumber } : null,
    ServerIsConnected: connected,
    LoginSubmitted: false,
    LoginErrorMessage: "",
    LoginDoLogin(name, pass) {
      loginCalls.push({ name, pass });
      if (fail) {
        this.LoginSubmitted = false;
        this.LoginErrorMessage = "InvalidNamePassword";
      } else {
        this.LoginSubmitted = true;
      }
    },
  };
  const documentListeners = new Map();
  const context = {
    console, Date, JSON, Math, Number, String, URL, Object,
    unsafeWindow: page,
    window: {},
    HTMLInputElement: MockInput,
    Event: class Event { constructor(type, options = {}) { this.type = type; this.bubbles = !!options.bubbles; } },
    setTimeout(callback, delay = 0) { scheduled.push({ callback, delay }); return scheduled.length; },
    GM_getValue(key, fallback) { return gmStore.has(key) ? gmStore.get(key) : fallback; },
    GM_setValue(key, value) { gmStore.set(key, value); },
    GM_deleteValue(key) { gmStore.delete(key); },
    GM_registerMenuCommand(label, callback) { menuCommands.push({ label, callback }); },
    document: {
      body,
      getElementById(id) {
        if (id === "misaka-ipad-guard-script") return appendedScript;
        return elements.get(id) || null;
      },
      createElement: makeElement,
      addEventListener(type, callback) { documentListeners.set(type, callback); },
      dispatchEvent(event) { documentListeners.get(event.type)?.(event); return true; },
      head: { appendChild(script) { appendedScript = script; } },
    },
  };
  vm.runInNewContext(loaderSource, context, { filename: "misaka-ipad-guard.user.js" });
  return {
    context, page, scheduled, gmStore, menuCommands, loginCalls, nameInput, passwordInput, elements,
    get appendedScript() { return appendedScript; },
  };
}

function runScheduled(loader, delay) {
  const index = loader.scheduled.findIndex((entry) => entry.delay === delay);
  assert.notEqual(index, -1, `expected scheduled callback after ${delay} ms`);
  const [{ callback }] = loader.scheduled.splice(index, 1);
  callback();
}

const unconfigured = loaderContext();
assert.equal(unconfigured.appendedScript, null, "chat runtime must not load on login screen");
assert.equal(unconfigured.loginCalls.length, 0, "missing credentials must never attempt login");
assert.match(unconfigured.elements.get("misaka-ipad-guard-login-status")?.textContent || "", /未配置/);
assert.equal(unconfigured.menuCommands.length, 2);
unconfigured.context.document.dispatchEvent(new unconfigured.context.Event("misaka-ipad-guard-open-login-config"));
const configOverlay = unconfigured.elements.get("misaka-ipad-guard-login-config");
assert.ok(configOverlay, "chat command event must open the private credential dialog");
const descendants = (root) => [root, ...(root.children || []).flatMap(descendants)];
const configNodes = descendants(configOverlay);
const configPassword = configNodes.find((node) => node.tagName === "INPUT");
const saveButton = configNodes.find((node) => node.tagName === "BUTTON" && node.textContent === "保存并启用");
assert.equal(configPassword?.type, "password", "credential dialog must mask the password");
configPassword.value = "saved-secret";
saveButton.dispatchEvent(new unconfigured.context.Event("click"));
assert.equal(unconfigured.gmStore.get("misaka_ipad_guard_login_enabled_v1"), true);
assert.equal(unconfigured.gmStore.get("misaka_ipad_guard_login_password_v1"), "saved-secret");
unconfigured.menuCommands.find((entry) => /清除/.test(entry.label)).callback();
assert.equal(unconfigured.gmStore.has("misaka_ipad_guard_login_password_v1"), false, "menu clear must delete password");
assert.equal(unconfigured.gmStore.has("misaka_ipad_guard_login_enabled_v1"), false, "menu clear must disable login");

const disconnected = loaderContext({ enabled: true, password: "secret", connected: false });
assert.match(disconnected.elements.get("misaka-ipad-guard-login-status")?.textContent || "", /等待插件加载.*5 秒/);
runScheduled(disconnected, 5000);
assert.equal(disconnected.loginCalls.length, 0, "login must wait for the BC server connection");
assert.match(disconnected.elements.get("misaka-ipad-guard-login-status")?.textContent || "", /等待.*服务器/);

const configured = loaderContext({ enabled: true, password: "test-password" });
assert.equal(configured.nameInput.value, "", "credentials must not be filled before the plugin grace period");
assert.match(configured.elements.get("misaka-ipad-guard-login-status")?.textContent || "", /等待插件加载.*5 秒/);
runScheduled(configured, 5000);
assert.equal(configured.nameInput.value, "MSK002");
assert.equal(configured.passwordInput.value, "test-password");
assert.deepEqual(configured.nameInput.events, ["input", "change"]);
assert.deepEqual(configured.passwordInput.events, ["input", "change"]);
runScheduled(configured, 250);
assert.deepEqual(configured.loginCalls, [{ name: "MSK002", pass: "test-password" }]);
runScheduled(configured, 500);
assert.equal(configured.loginCalls.length, 1, "automatic login must run at most once per page");

const failed = loaderContext({ enabled: true, password: "wrong", fail: true });
runScheduled(failed, 5000);
runScheduled(failed, 250);
runScheduled(failed, 500);
assert.equal(failed.loginCalls.length, 1, "failed login must not loop");
assert.match(failed.elements.get("misaka-ipad-guard-login-status")?.textContent || "", /登录失败/);

const chatLoader = loaderContext({ screen: "ChatRoom", enabled: true, password: "secret" });
chatLoader.page.bcModSdk = {};
chatLoader.page.ChatRoomSendChat = () => {};
chatLoader.page.ChatRoomMessage = () => {};
runScheduled(chatLoader, 500);
assert.ok(chatLoader.appendedScript, "runtime must load in ChatRoom for Misaka account");
assert.equal(chatLoader.appendedScript.dataset.mode, "chatroom");
assert.match(chatLoader.appendedScript.src || "", /v=0\.3\.1/);
assert.equal(chatLoader.loginCalls.length, 0);
const wrongAccount = loaderContext({ screen: "ChatRoom", memberNumber: 999999 });
wrongAccount.page.bcModSdk = {};
wrongAccount.page.ChatRoomSendChat = () => {};
wrongAccount.page.ChatRoomMessage = () => {};
runScheduled(wrongAccount, 500);
assert.equal(wrongAccount.appendedScript, null, "Guard runtime must reject a non-Misaka account");

assert.match(loaderSource, /@grant\s+GM_getValue/);
assert.match(loaderSource, /@grant\s+GM_setValue/);
assert.match(loaderSource, /@grant\s+GM_deleteValue/);
assert.match(loaderSource, /LoginDoLogin\(LOGIN_NAME, password\)/);
assert.doesNotMatch(loaderSource, /localStorage[^\n]*(?:password|credential)/i, "password must not use page storage");
assert.doesNotMatch(loaderSource, /WCE|DrawButton|MainCanvas\.click/, "native login must not depend on WCE clicks");

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

console.log("iPad guard v0.3.1 tests passed");
