// GimpSorter v1.3 — BC Gimp Doll 自动排序 mod
// 通过 bcModSdk.registerMod 注册，掉线重连后由 FUSAM 自动重新加载
// 排序规则：所有 GIMP 娃娃按编号从小到大排在房间最前面
(function() {
  "use strict";

  const mod = bcModSdk.registerMod({
    name: "GimpSorter",
    fullName: "Gimp Doll 自动排序",
    version: "1.3.0",
    repository: "https://github.com/Igallta/bc-gimp-sorter"
  });

  const config = {
    enabled: true,
    pollMs: 3000,
    moveDelayMs: 300,
    gimpPattern: /^GIMP \d{3}$/,
    busy: false,
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

  async function sortOnce() {
    if (!ChatRoomPlayerIsAdmin()) return;
    config.busy = true;
    try {
      let safety = 0;
      while (config.enabled && safety < 80) {
        const gimps = getGimps();
        if (gimps.length === 0) break;
        const sorted = [].concat(gimps).sort((a, b) => a.gimpNum - b.gimpNum);
        let target = null;
        let targetPos = -1;
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i].index !== i) {
            target = sorted[i];
            targetPos = i;
            break;
          }
        }
        if (target === null) break;
        log("移动 GIMP " + target.gimpNum + " #" + target.memberNumber + " 从位置" + target.index + " → 目标位置" + targetPos);
        ServerSend("ChatRoomAdmin", {
          MemberNumber: target.memberNumber,
          Action: "MoveLeft",
          Publish: false
        });
        safety++;
        await sleep(config.moveDelayMs);
      }
      if (safety >= 80) {
        log("⚠️ 安全限制触发，本轮停止");
      } else if (safety > 0) {
        const allGood = !needsReorder();
        log("✅ 排序完成，共移动 " + safety + " 次" + (allGood ? "，全部到位" : "，仍有未到位"));
      }
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
      } else if (cmd === "status") {
        const gimps = getGimps();
        const sorted = [].concat(gimps).sort((a, b) => a.gimpNum - b.gimpNum);
        log("状态: " + (config.enabled ? "开启" : "关闭") + " | GIMP: " + gimps.length + "个 | 需排序: " + needsReorder() + " | 搬运中: " + config.busy);
        log("目标顺序: " + sorted.map(g => g.gimpNum).join(" → "));
        gimps.forEach(g => {
          const ok = g.index < gimps.length;
          log("  GIMP " + g.gimpNum + " (#" + g.memberNumber + ") @ 位置" + g.index + (ok ? " ✓" : " ✗ 需前移"));
        });
      } else {
        log("用法: /gimpsorter on|off|status");
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

  log("Gimp Doll 自动排序 v1.3 已加载。命令: /gimpsorter on|off|status");
})();