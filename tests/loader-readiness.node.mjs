import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function makeContext() {
  const timers = [];
  const scripts = [];
  const elements = new Map();
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
assert.equal(misaka.scripts.length, 0, "MisakaChat must not inject on the login screen");
misaka.context.CurrentScreen = "ChatRoom";
misaka.runNextTimer();
assert.equal(misaka.scripts.length, 0, "MisakaChat must wait for the room message APIs");
misaka.context.ChatRoomMessage = () => {};
misaka.context.ChatRoomSendChat = () => {};
misaka.runNextTimer();
assert.equal(misaka.scripts.at(-1)?.id, "misaka-persona-script");

console.log("loader chat readiness: 6/6");
