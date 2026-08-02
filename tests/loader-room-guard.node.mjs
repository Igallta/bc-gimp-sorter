import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../misaka-chat.user.js", import.meta.url), "utf8");

function run(memberNumber) {
  const observations = [];
  const context = {
    console: { log() {}, error() {} },
    setTimeout() { return 1; },
    document: { readyState: "complete" },
    CurrentScreen: "ChatSearch",
    Player: {
      MemberNumber: memberNumber,
      ImmersionSettings: {
        ReturnToChatRoom: true,
        ReturnToChatRoomAdmin: true,
      },
    },
    ChatSearchAutoJoinRoom() {
      observations.push(context.Player.ImmersionSettings.ReturnToChatRoomAdmin);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "misaka-chat.user.js" });
  context.ChatSearchAutoJoinRoom();
  return { observations, restored: context.Player.ImmersionSettings.ReturnToChatRoomAdmin };
}

const misaka = run(194331);
assert.deepEqual(misaka.observations, [false]);
assert.equal(misaka.restored, true);

const other = run(166706);
assert.deepEqual(other.observations, [true]);
assert.equal(other.restored, true);

console.log("loader room recreate guard: 2/2");
