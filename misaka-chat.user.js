// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      3.0.10
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆(IDB) + 房间上下文
// @match        https://*.bondageprojects.elementfx.com/R*/*
// @match        https://*.bondage-europe.com/R*/*
// @match        https://*.bondageprojects.com/R*/*
// @match        https://*.bondage-asia.com/club/R*
// @match        https://*.bondageclub.com/R*/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-chat.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @connect      api.openai.com
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  // 不再硬编码任何 API key — 通过 BC 控制台手动设置：
  // localStorage.setItem("misaka_apikey", "sk-xxx")
  // localStorage.setItem("misaka_openai_key", "sk-proj-xxx")

  // 把 GM 函数暴露到 window，让注入的脚本能用
  try { window.__GM_xmlhttpRequest = GM_xmlhttpRequest; } catch(e) {}
  try { window.__GM_getValue = GM_getValue; } catch(e) {}
  try { window.__GM_setValue = GM_setValue; } catch(e) {}

  const SCRIPT_VERSION = "3.0.10";
  // GitHub Pages 部署曾长期卡住并返回 2.5.3。资源钉住本版本对应的 commit，
  // 避免 Pages/master CDN 缓存让 loader 版本与实际主脚本不一致。
  const ASSET_REVISION = "652d0eb";
  const BASE_URL = `https://raw.githack.com/Igallta/bc-gimp-sorter/${ASSET_REVISION}`;

  // BC 的“返回上个房间并恢复管理员房间”会在搜索阶段短暂没找到房间时
  // 调用 ChatRoomCreate，随后由 ChatRoomRecreate 以当前玩家身份发布一次完整
  // Room Update。御坂只是房间管理员，不应因为自动回房而重建/覆盖公共房间。
  // 仅在 ChatSearchAutoJoinRoom 本次调用期间临时关闭管理员恢复；找到现有房间
  // 后的正常加入不依赖该开关，账号持久设置也不会被修改。
  function installNativeRoomRecreateGuard(attempts) {
    attempts = attempts || 0;
    if (typeof ChatSearchAutoJoinRoom !== "function" ||
        typeof Player === "undefined" || !Player) {
      if (attempts < 600) setTimeout(() => installNativeRoomRecreateGuard(attempts + 1), 50);
      return;
    }
    if (Player.MemberNumber !== 194331 || window.__misakaNativeRoomRecreateGuard) return;
    const original = ChatSearchAutoJoinRoom;
    window.__misakaOrigChatSearchAutoJoinRoom = original;
    window.ChatSearchAutoJoinRoom = function() {
      const settings = Player?.ImmersionSettings;
      const restoreAdminRoom = settings?.ReturnToChatRoomAdmin;
      if (settings) settings.ReturnToChatRoomAdmin = false;
      try {
        return original.apply(this, arguments);
      } finally {
        if (settings) settings.ReturnToChatRoomAdmin = restoreAdminRoom;
      }
    };
    window.__misakaNativeRoomRecreateGuard = true;
    console.log("[MisakaChat] 已阻止自动回房重建管理员房间");
  }

  installNativeRoomRecreateGuard();

  function waitForReady(cb, attempts) {
    attempts = attempts || 0;
    if (typeof Player !== "undefined" && Player && Player.MemberNumber === 194331 &&
        typeof bcModSdk !== "undefined" &&
        typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" &&
        typeof ChatRoomMessage === "function" &&
        typeof ChatRoomSendChat === "function") {
      cb();
    } else {
      if (attempts > 0 && attempts % 60 === 0) {
        console.log("[MisakaChat] 等待进入 ChatRoom 中... " + attempts + "s");
      }
      setTimeout(() => waitForReady(cb, attempts + 1), 1000);
    }
  }

  function loadScript(id, url, onload, onerror) {
    const existing = document.getElementById(id);
    if (existing) {
      const currentVersion = existing.dataset?.misakaVersion || "";
      const currentSrc = existing.getAttribute("src") || "";
      if (currentVersion === SCRIPT_VERSION || currentSrc.includes(`v=${SCRIPT_VERSION}`)) {
        if (onload) onload();
        return;
      }
      console.log(`[MisakaChat] 替换旧脚本 ${id}: ${currentVersion || currentSrc || "unknown"} -> ${SCRIPT_VERSION}`);
      existing.remove();
    }
    const s = document.createElement("script");
    s.id = id;
    s.dataset.misakaVersion = SCRIPT_VERSION;
    s.src = url;
    s.onload = onload;
    s.onerror = onerror || (() => console.error("[MisakaChat] 加载失败: " + url));
    document.head.appendChild(s);
  }

  waitForReady(() => {
    if (window.__misakaUserLoaderLoaded === SCRIPT_VERSION && window.__misakaInstance) {
      console.log("[MisakaChat] 已加载，跳过重复注入");
      return;
    }
    window.__misakaUserLoaderLoaded = SCRIPT_VERSION;
    // 加载人设文件
    loadScript("misaka-persona-script", `${BASE_URL}/misaka-persona.js?v=${SCRIPT_VERSION}`, () => {
      console.log("[MisakaChat] 人设文件已加载");
      // 加载主脚本
      loadScript("misaka-chat-script", `${BASE_URL}/misaka-chat.js?v=${SCRIPT_VERSION}`, () => {
        console.log("[MisakaChat] 主脚本已加载");
      });
    });
  });
})();
