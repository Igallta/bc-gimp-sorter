// GimpSorter v1.7.3 — BC Gimp Doll 自动排序 mod
// 通过 bcModSdk.registerMod 注册，掉线重连后由油猴自动重新加载
// 排序规则：GIMP → Gimp → Doll → GIMP Pet → Pet → Error，组内先三位、后四位，再按编号升序
// 策略：只使用 MoveLeft，行为更稳定可预测
(function() {
  "use strict";

  const version = "1.7.3";
  if (window.__GimpSorterLoaded) {
    console.log("[GimpSorter] already loaded: " + window.__GimpSorterLoaded);
    return;
  }
  window.__GimpSorterLoaded = version;

  const mod = bcModSdk.registerMod({
    name: "GimpSorter",
    fullName: "Gimp Doll 自动排序",
    version,
    repository: "https://github.com/Igallta/bc-gimp-sorter"
  });

  const config = {
    enabled: true,
    pollMs: 1000,
    sortCooldownMs: 1000,  // 排序后等待服务器同步
    busy: false,
    debug: false,
  };

  const dollTypes = [
    { type: "GIMP", rank: 0, pattern: /^GIMP (\d{3,4})$/ },
    { type: "Gimp", rank: 1, pattern: /^Gimp (\d{3,4})$/ },
    { type: "Doll", rank: 2, pattern: /^Doll (\d{3,4})$/i },
    { type: "GIMP Pet", rank: 3, pattern: /^GIMP Pet (\d{3,4})$/i },
    { type: "Pet", rank: 4, pattern: /^Pet (\d{3,4})$/i },
    { type: "Error", rank: 5, pattern: /^Error (\d{3,4})$/i },
  ];

  function log(msg) {
    if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" && typeof ChatRoomMessage === "function") {
      ChatRoomMessage({
        Content: `<font color="#00CCFF">[GimpSorter] ${msg}</font>`,
        Type: "LocalMessage",
        Sender: Player.MemberNumber,
      });
    } else if (typeof ChatRoomSendLocal === "function") {
      ChatRoomSendLocal("[GimpSorter] " + msg);
    } else {
      console.log("[GimpSorter] " + msg);
    }
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function debug(msg) {
    if (config.debug) log(msg);
  }

  function parseDollIdentity(nickname) {
    const name = String(nickname || "").trim();
    for (const dollType of dollTypes) {
      const match = dollType.pattern.exec(name);
      if (match) {
        return {
          type: dollType.type,
          typeRank: dollType.rank,
          digitCount: match[1].length,
          number: parseInt(match[1], 10),
        };
      }
    }

    // 除规范的全大写 GIMP 外，其余大小写变体归入 Gimp 组。
    // 这样既兼容旧名字，也保留房间要求的 GIMP → Gimp 优先级。
    const mixedCaseGimp = /^gimp (\d{3,4})$/i.exec(name);
    if (mixedCaseGimp) {
      return {
        type: "Gimp",
        typeRank: 1,
        digitCount: mixedCaseGimp[1].length,
        number: parseInt(mixedCaseGimp[1], 10),
      };
    }
    return null;
  }

  function compareDolls(a, b) {
    return a.typeRank - b.typeRank ||
      a.digitCount - b.digitCount ||
      a.dollNumber - b.dollNumber ||
      a.index - b.index;
  }

  function getDolls() {
    if (typeof ChatRoomCharacter === "undefined" || !ChatRoomCharacter) return [];
    return ChatRoomCharacter
      .map((c, i) => {
        const nickname = c.Nickname || c.Name || "";
        const identity = parseDollIdentity(nickname);
        return identity ? {
          index: i,
          memberNumber: c.MemberNumber,
          nickname,
          dollType: identity.type,
          typeRank: identity.typeRank,
          digitCount: identity.digitCount,
          dollNumber: identity.number,
        } : null;
      })
      .filter(Boolean);
  }

  function needsReorder() {
    const dolls = getDolls();
    if (dolls.length === 0) return false;
    const sorted = [].concat(dolls).sort(compareDolls);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].index !== i) return true;
    }
    return false;
  }

  function getMoveLeftPlan() {
    if (typeof ChatRoomCharacter === "undefined" || !ChatRoomCharacter) return [];

    const order = ChatRoomCharacter.map(c => ({
      memberNumber: c.MemberNumber,
      nickname: c.Nickname || c.Name || "",
      identity: parseDollIdentity(c.Nickname || c.Name || ""),
    }));
    const sortedDolls = order
      .map((entry, index) => entry.identity ? {
        ...entry,
        index,
        dollType: entry.identity.type,
        typeRank: entry.identity.typeRank,
        digitCount: entry.identity.digitCount,
        dollNumber: entry.identity.number,
      } : null)
      .filter(Boolean)
      .sort(compareDolls);
    const plan = [];

    for (let targetPos = 0; targetPos < sortedDolls.length; targetPos++) {
      const target = sortedDolls[targetPos];
      let currentPos = order.findIndex(c => c.memberNumber === target.memberNumber);
      while (currentPos > targetPos) {
        plan.push({
          memberNumber: target.memberNumber,
          dollType: target.dollType,
          dollNumber: target.dollNumber,
          from: currentPos,
          to: currentPos - 1,
        });
        const tmp = order[currentPos - 1];
        order[currentPos - 1] = order[currentPos];
        order[currentPos] = tmp;
        currentPos--;
      }
    }

    return plan;
  }

  async function sortOnce() {
    if (!ChatRoomPlayerIsAdmin()) return;
    config.busy = true;
    try {
      const plan = getMoveLeftPlan();
      if (plan.length === 0) return;

      debug("调试：本轮左移计划 | 步数：" + plan.length);

      for (const step of plan) {
        if (!config.enabled) break;
        ServerSend("ChatRoomAdmin", {
          MemberNumber: step.memberNumber,
          Action: "MoveLeft",
          Publish: false
        });
        debug("调试：移动 | 娃娃：" + step.dollType + " " + String(step.dollNumber).padStart(3, "0") + " | 位置：" + step.from + "→" + step.to);
        await sleep(50);
      }

      // 等待服务器同步位置
      await sleep(config.sortCooldownMs);
      debug("调试：排序循环结束 | 需排序：" + (needsReorder() ? "是" : "否"));
    } catch (e) {
      console.error("[GimpSorter] error:", e);
      log("❌ 排序失败：" + e.message);
    } finally {
      config.busy = false;
    }
  }

  mod.hookFunction("ChatRoomSendChat", 1, (args, next) => {
    const msg = args[0];
    if (msg && msg.startsWith("/gimpsorter")) {
      const cmd = msg.slice("/gimpsorter".length).trim();
      if (cmd === "on" || cmd === "") {
        config.enabled = true;
        log("✅ 已开启：自动排序");
      } else if (cmd === "off") {
        config.enabled = false;
        log("⏹ 已关闭：自动排序");
      } else if (cmd === "debug on") {
        config.debug = true;
        log("✅ 已开启：调试");
      } else if (cmd === "debug off") {
        config.debug = false;
        log("⏹ 已关闭：调试");
      } else if (cmd === "status") {
        const dolls = getDolls();
        const sorted = [].concat(dolls).sort(compareDolls);
        log("状态：" + (config.enabled ? "开启" : "关闭") + " | 调试：" + (config.debug ? "开启" : "关闭") + " | 娃娃：" + dolls.length + " | 需排序：" + (needsReorder() ? "是" : "否") + " | 搬运中：" + (config.busy ? "是" : "否"));
        log("目标顺序：" + sorted.map(d => d.dollType + " " + String(d.dollNumber).padStart(3, "0")).join(" → "));
        dolls.forEach(d => {
          const targetPos = sorted.findIndex(s => s.memberNumber === d.memberNumber);
          const ok = d.index === targetPos;
          log("娃娃：" + d.dollType + " " + String(d.dollNumber).padStart(3, "0") + " | 编号：#" + d.memberNumber + " | 当前位置：" + d.index + (ok ? " | 状态：已就位" : " | 目标位置：" + targetPos));
        });
      } else {
        log("用法：/gimpsorter on|off|status|debug on|debug off");
      }
      return;
    }
    return next(args);
  });

  setInterval(() => {
    if (!config.enabled || config.busy) return;
    if (typeof ChatRoomPlayerIsAdmin === "undefined" || !ChatRoomPlayerIsAdmin()) return;
    if (typeof ChatRoomCharacter === "undefined" || !ChatRoomCharacter) return;
    if (needsReorder()) {
      sortOnce();
    }
  }, config.pollMs);

  window.__GimpSorterTestHooks = {
    parseDollIdentity,
    getMoveLeftPlan,
    needsReorder,
    sortNames(names) {
      return names.map((nickname, index) => {
        const identity = parseDollIdentity(nickname);
        return identity ? {
          nickname,
          index,
          typeRank: identity.typeRank,
          digitCount: identity.digitCount,
          dollNumber: identity.number,
        } : null;
      }).filter(Boolean).sort(compareDolls).map(entry => entry.nickname);
    },
  };

  log("娃娃自动排序 " + version + " 已加载");
})();
