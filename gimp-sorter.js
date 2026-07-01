// GimpSorter v1.5 — BC Gimp Doll 自动排序 mod
// 通过 bcModSdk.registerMod 注册，掉线重连后由油猴自动重新加载
// 排序规则：所有 GIMP 娃娃按编号从小到大排在房间最前面
// 优化：按场景选择 MoveLeft / MoveRight，避免绕远路
(function() {
  "use strict";

  const mod = bcModSdk.registerMod({
    name: "GimpSorter",
    fullName: "Gimp Doll 自动排序",
    version: "1.5.0",
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

  function findNextMove() {
    const gimps = getGimps();
    if (gimps.length === 0) return null;

    const sorted = [].concat(gimps).sort((a, b) => a.gimpNum - b.gimpNum);
    const desiredByMember = new Map(sorted.map((g, i) => [g.memberNumber, i]));

    // If all GIMPs are already in the front block, sort that block directly.
    // This handles manual tests like putting GIMP 777 before GIMP 104 by moving
    // the too-large GIMP right instead of pushing every smaller GIMP left.
    const frontAllGimps = ChatRoomCharacter
      .slice(0, sorted.length)
      .every(c => desiredByMember.has(c.MemberNumber));

    if (frontAllGimps) {
      const byIndex = [].concat(gimps).sort((a, b) => a.index - b.index);
      for (let i = 0; i < byIndex.length; i++) {
        const target = byIndex[i];
        const targetPos = desiredByMember.get(target.memberNumber);
        if (targetPos === i) continue;
        return {
          target,
          targetPos,
          direction: targetPos > i ? "MoveRight" : "MoveLeft",
          moveCount: Math.abs(targetPos - i),
        };
      }
    }

    // Otherwise prioritize pulling the next expected GIMP into the front block.
    // This is the normal reconnect case where a GIMP appears near the room end.
    for (let i = 0; i < sorted.length; i++) {
      const target = sorted[i];
      if (target.index === i) continue;
      return {
        target,
        targetPos: i,
        direction: target.index > i ? "MoveLeft" : "MoveRight",
        moveCount: Math.abs(target.index - i),
      };
    }

    return null;
  }

  async function sortOnce() {
    if (!ChatRoomPlayerIsAdmin()) return;
    config.busy = true;
    try {
      let totalMoves = 0;
      let pass = 0;
      let safety = 0;

      while (config.enabled && safety < 40) {
        const move = findNextMove();
        if (move === null || move.moveCount === 0) break;
        const { target, targetPos, direction, moveCount } = move;

        log("GIMP " + target.gimpNum + " 从位置" + target.index + " " + direction + " " + moveCount + "位到位置" + targetPos);

        // 连续发送，每个之间隔 50ms 避免客户端动画抽搐
        for (let i = 0; i < moveCount; i++) {
          ServerSend("ChatRoomAdmin", {
            MemberNumber: target.memberNumber,
            Action: direction,
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

  log("Gimp Doll 自动排序 v1.5 已加载（双向移动模式）。命令: /gimpsorter on|off|status");
})();
