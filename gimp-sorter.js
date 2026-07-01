// GimpSorter v1.6 — BC Gimp Doll 自动排序 mod
// 通过 bcModSdk.registerMod 注册，掉线重连后由油猴自动重新加载
// 排序规则：所有 GIMP 娃娃按编号从小到大排在房间最前面
// 策略：只使用 MoveLeft，行为更稳定可预测
(function() {
  "use strict";

  const mod = bcModSdk.registerMod({
    name: "GimpSorter",
    fullName: "Gimp Doll 自动排序",
    version: "1.6.0",
    repository: "https://github.com/Igallta/bc-gimp-sorter"
  });

  const config = {
    enabled: true,
    pollMs: 3000,
    sortCooldownMs: 1500,  // 排序后等待服务器同步
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
      let totalMoves = 0;
      let pass = 0;
      let safety = 0;

      while (config.enabled && safety < 40) {
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

        const moveCount = target.index - targetPos;
        if (moveCount <= 0) break;

        log("GIMP " + target.gimpNum + " 从位置" + target.index + " MoveLeft " + moveCount + "位到位置" + targetPos);

        // 连续发送，每个之间隔 50ms 避免客户端动画抽搐
        for (let i = 0; i < moveCount; i++) {
          ServerSend("ChatRoomAdmin", {
            MemberNumber: target.memberNumber,
            Action: "MoveLeft",
            Publish: false
          });
          await sleep(50);
        }

        totalMoves += moveCount;
        pass++;
        safety++;

        // 等待服务器同步位置
        await sleep(config.sortCooldownMs);
      }

      if (totalMoves > 0) {
        const allGood = !needsReorder();
        log("✅ 排序完成，" + pass + "轮共移动" + totalMoves + "次" + (allGood ? "，全部到位" : "，仍有未到位"));
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
          const targetPos = sorted.findIndex(s => s.memberNumber === g.memberNumber);
          const ok = g.index === targetPos;
          log("  GIMP " + g.gimpNum + " (#" + g.memberNumber + ") @ 位置" + g.index + (ok ? " ✓" : " → 目标位置" + targetPos));
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

  log("Gimp Doll 自动排序 v1.6 已加载（MoveLeft only）。命令: /gimpsorter on|off|status");
})();
