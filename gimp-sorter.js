// GimpSorter v1.6.4 — BC Gimp Doll 自动排序 mod
// 通过 bcModSdk.registerMod 注册，掉线重连后由油猴自动重新加载
// 排序规则：所有 GIMP 娃娃按编号从小到大排在房间最前面
// 策略：只使用 MoveLeft，行为更稳定可预测
(function() {
  "use strict";

  const version = "1.6.4";
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
    gimpPattern: /^GIMP \d{3}$/,
    busy: false,
    debug: false,
  };

  function log(msg) {
    if (typeof ChatRoomSendLocal === "function") {
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

  function getGimpNumber(nickname) {
    const m = /^GIMP (\d{3})$/.exec(nickname || "");
    return m ? parseInt(m[1], 10) : null;
  }

  function getGimps() {
    if (typeof ChatRoomCharacter === "undefined" || !ChatRoomCharacter) return [];
    return ChatRoomCharacter
      .map((c, i) => ({
        index: i,
        memberNumber: c.MemberNumber,
        nickname: c.Nickname || c.Name || "",
        gimpNum: getGimpNumber(c.Nickname || c.Name || ""),
      }))
      .filter(c => c.gimpNum !== null);
  }

  function needsReorder() {
    const gimps = getGimps();
    if (gimps.length === 0) return false;
    const sorted = [].concat(gimps).sort((a, b) => a.gimpNum - b.gimpNum);
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
      gimpNum: getGimpNumber(c.Nickname || c.Name || ""),
    }));
    const sortedGimps = order
      .filter(c => c.gimpNum !== null)
      .sort((a, b) => a.gimpNum - b.gimpNum);
    const plan = [];

    for (let targetPos = 0; targetPos < sortedGimps.length; targetPos++) {
      const target = sortedGimps[targetPos];
      let currentPos = order.findIndex(c => c.memberNumber === target.memberNumber);
      while (currentPos > targetPos) {
        plan.push({
          memberNumber: target.memberNumber,
          gimpNum: target.gimpNum,
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

      debug("本轮 MoveLeft 计划: " + plan.length + " 步");

      for (const step of plan) {
        if (!config.enabled) break;
        ServerSend("ChatRoomAdmin", {
          MemberNumber: step.memberNumber,
          Action: "MoveLeft",
          Publish: false
        });
        debug("GIMP " + step.gimpNum + " " + step.from + "→" + step.to);
        await sleep(50);
      }

      // 等待服务器同步位置
      await sleep(config.sortCooldownMs);
      debug("排序循环结束，当前需排序: " + needsReorder());
    } catch (e) {
      console.error("[GimpSorter] error:", e);
      log("❌ 排序出错: " + e.message);
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
        log("✅ 已开启自动排序");
      } else if (cmd === "off") {
        config.enabled = false;
        log("⏹ 已关闭自动排序");
      } else if (cmd === "debug on") {
        config.debug = true;
        log("debug 已开启");
      } else if (cmd === "debug off") {
        config.debug = false;
        log("debug 已关闭");
      } else if (cmd === "status") {
        const gimps = getGimps();
        const sorted = [].concat(gimps).sort((a, b) => a.gimpNum - b.gimpNum);
        log("状态: " + (config.enabled ? "开启" : "关闭") + " | debug: " + (config.debug ? "开" : "关") + " | GIMP: " + gimps.length + "个 | 需排序: " + needsReorder() + " | 搬运中: " + config.busy);
        log("目标顺序: " + sorted.map(g => g.gimpNum).join(" → "));
        gimps.forEach(g => {
          const targetPos = sorted.findIndex(s => s.memberNumber === g.memberNumber);
          const ok = g.index === targetPos;
          log("  GIMP " + g.gimpNum + " (#" + g.memberNumber + ") @ 位置" + g.index + (ok ? " ✓" : " → 目标位置" + targetPos));
        });
      } else {
        log("用法: /gimpsorter on|off|status|debug on|debug off");
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

  console.log("[GimpSorter] Gimp Doll 自动排序 v" + version + " 已加载（MoveLeft only）");
})();
