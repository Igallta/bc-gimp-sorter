// ==UserScript==
// @name         Misaka iPad WebContent Guard
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      0.1.2
// @description  iPadOS Safari 上为御坂提供定时同站完整刷新与诊断日志
// @match        https://*.bondageprojects.elementfx.com/R*/*
// @match        https://*.bondage-europe.com/R*/*
// @match        https://*.bondageprojects.com/R*/*
// @match        https://*.bondage-asia.com/club/R*
// @match        https://*.bondageclub.com/R*/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @downloadURL  https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.1.2";
  const MEMBER_NUMBER = 194331;
  if (window.__MisakaIPadGuardLoaderStarted) return;
  window.__MisakaIPadGuardLoaderStarted = VERSION;

  function load(attempt) {
    if (window.__MisakaIPadGuard) return;
    // 和已在 iPad 验证稳定的 Misaka loader 保持一致：必须等到真正进入
    // ChatRoom，且发送/本地消息入口都已建立后，才安装 Guard hooks。
    if (typeof bcModSdk === "undefined" ||
        typeof Player === "undefined" || !Player ||
        typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom" ||
        typeof ChatRoomSendChat !== "function" ||
        typeof ChatRoomMessage !== "function") {
      if (attempt < 1200) setTimeout(() => load(attempt + 1), 500);
      return;
    }
    if (Number(Player.MemberNumber || Player.ID) !== MEMBER_NUMBER) return;
    const existing = document.getElementById("misaka-ipad-guard-script");
    if (existing) {
      // script.onload 不代表 runtime 一定完成 init；旧版可能在房间入口尚未
      // 就绪时抛错。没有实例就移除节点并重新注入，而不是永久卡住。
      existing.remove();
    }

    const script = document.createElement("script");
    script.id = "misaka-ipad-guard-script";
    script.dataset.version = VERSION;
    script.src = `https://igallta.github.io/bc-gimp-sorter/misaka-ipad-guard.js?v=${VERSION}`;
    script.onload = () => {
      if (window.__MisakaIPadGuard) {
        console.log(`[iPadGuard] runtime ${VERSION} loaded`);
        return;
      }
      console.error("[iPadGuard] runtime loaded without initializing; retrying");
      script.remove();
      if (attempt < 1200) setTimeout(() => load(attempt + 1), 1000);
    };
    script.onerror = () => {
      console.error("[iPadGuard] runtime load failed; retrying");
      script.remove();
      if (attempt < 1200) setTimeout(() => load(attempt + 1), 1000);
    };
    document.head.appendChild(script);
  }

  load(0);
})();
