import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../gimp-sorter.js", import.meta.url), "utf8");
const windowObject = {};
const context = vm.createContext({
  window: windowObject,
  console,
  setInterval() { return 1; },
  setTimeout,
  ChatRoomCharacter: [],
  ChatRoomPlayerIsAdmin() { return false; },
  bcModSdk: {
    registerMod() {
      return { hookFunction() {} };
    },
  },
});

vm.runInContext(source, context, { filename: "gimp-sorter.js" });
const hooks = windowObject.__GimpSorterTestHooks;
assert.ok(hooks, "test hooks should be exposed");
let assertions = 1;
assert.match(source, /<font color="#00CCFF">\[GimpSorter\]/, "local messages must share MisakaChat's color");
assertions++;
assert.match(source, /log\("娃娃自动排序 " \+ version \+ " 已加载"\)/, "startup copy must follow the shared product/version style");
assertions++;

const recognized = [
  ["GIMP 104", "GIMP", 3, 104],
  ["Gimp 1004", "Gimp", 4, 1004],
  ["gimp 104", "Gimp", 3, 104],
  ["DOLL 1441", "Doll", 4, 1441],
  ["gimp pet 135", "GIMP Pet", 3, 135],
  ["PET 1777", "Pet", 4, 1777],
  ["error 795", "Error", 3, 795],
];
for (const [name, type, digitCount, number] of recognized) {
  assert.deepEqual(
    { ...hooks.parseDollIdentity(name) },
    { type, typeRank: ["GIMP", "Gimp", "Doll", "GIMP Pet", "Pet", "Error"].indexOf(type), digitCount, number },
  );
  assertions++;
}

for (const name of ["GIMP 12", "GIMP 12345", "GIMP Pet", "Player 104", "Doll ABC"]) {
  assert.equal(hooks.parseDollIdentity(name), null, `${name} should not be sortable`);
  assertions++;
}

const input = [
  "Player 999",
  "Error 002",
  "Pet 001",
  "GIMP Pet 009",
  "Doll 003",
  "Gimp 010",
  "GIMP 020",
  "GIMP 1200",
  "GIMP 1001",
  "GIMP 001",
  "Gimp 002",
  "Doll 001",
  "Doll 1000",
  "GIMP Pet 001",
  "Pet 003",
  "Error 001",
  "Error 1002",
];
assert.deepEqual(Array.from(hooks.sortNames(input)), [
  "GIMP 001",
  "GIMP 020",
  "GIMP 1001",
  "GIMP 1200",
  "Gimp 002",
  "Gimp 010",
  "Doll 001",
  "Doll 003",
  "Doll 1000",
  "GIMP Pet 001",
  "GIMP Pet 009",
  "Pet 001",
  "Pet 003",
  "Error 001",
  "Error 002",
  "Error 1002",
]);
assertions++;

context.ChatRoomCharacter = input.map((nickname, index) => ({
  MemberNumber: 100000 + index,
  Nickname: nickname,
}));
assert.equal(hooks.needsReorder(), true);
assertions++;
const simulatedOrder = [...context.ChatRoomCharacter];
for (const step of hooks.getMoveLeftPlan()) {
  const currentIndex = simulatedOrder.findIndex(character =>
    character.MemberNumber === step.memberNumber);
  assert.ok(currentIndex > 0, "MoveLeft must have a character on its left");
  [simulatedOrder[currentIndex - 1], simulatedOrder[currentIndex]] =
    [simulatedOrder[currentIndex], simulatedOrder[currentIndex - 1]];
}
assertions++;
assert.deepEqual(
  simulatedOrder.slice(0, hooks.sortNames(input).length).map(character => character.Nickname),
  Array.from(hooks.sortNames(input)),
);
assertions++;

console.log(`gimp sorter taxonomy and MoveLeft plan: ${assertions}/${assertions}`);
