// ==UserScript==
// @name         Misaka iPad WebContent Guard
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      0.2.3
// @description  iPadOS Safari 上为御坂提供跨站 WebContent 回收、WCE 快速登录与诊断日志
// @match        https://*.bondageprojects.elementfx.com/R*/*
// @match        https://*.bondage-europe.com/R*/*
// @match        https://*.bondageprojects.com/R*/*
// @match        https://*.bondage-asia.com/club/R*
// @match        https://*.bondageclub.com/R*/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @downloadURL  https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.2.3";
  const MEMBER_NUMBER = 194331;
  const ASSET_REVISION = "be631b8";
  const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;

  if (pageWindow.__MisakaIPadGuardLoaderStarted === VERSION) return;
  pageWindow.__MisakaIPadGuardLoaderStarted = VERSION;

  let runtimeLoading = false;

  function loadRuntime() {
    if (pageWindow.__MisakaIPadGuard || runtimeLoading) return;
    const onLoginScreen = pageWindow.CurrentScreen === "Login";
    const chatRoomReady =
      typeof pageWindow.bcModSdk !== "undefined" &&
      typeof pageWindow.Player !== "undefined" && !!pageWindow.Player &&
      pageWindow.CurrentScreen === "ChatRoom" &&
      typeof pageWindow.ChatRoomSendChat === "function" &&
      typeof pageWindow.ChatRoomMessage === "function" &&
      Number(pageWindow.Player.MemberNumber || pageWindow.Player.ID) === MEMBER_NUMBER;
    if (!onLoginScreen && !chatRoomReady) return;
    if (onLoginScreen && pageWindow.__MisakaIPadGuardLoginRecovery?.version === VERSION) return;

    const existing = document.getElementById("misaka-ipad-guard-script");
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.id = "misaka-ipad-guard-script";
    script.dataset.version = VERSION;
    script.dataset.mode = onLoginScreen ? "login" : "chatroom";
    script.src = `https://raw.githack.com/Igallta/bc-gimp-sorter/${ASSET_REVISION}/misaka-ipad-guard.js?v=${VERSION}`;
    runtimeLoading = true;
    script.onload = () => {
      runtimeLoading = false;
      if (pageWindow.__MisakaIPadGuard || pageWindow.__MisakaIPadGuardLoginRecovery?.version === VERSION) {
        console.log(`[iPadGuard] runtime ${VERSION} loaded`);
        return;
      }
      console.error("[iPadGuard] runtime loaded without initializing; retrying");
      script.remove();
    };
    script.onerror = () => {
      runtimeLoading = false;
      console.error("[iPadGuard] runtime load failed; retrying");
      script.remove();
    };
    document.head.appendChild(script);
  }

  function tick() {
    loadRuntime();
    setTimeout(tick, 500);
  }

  tick();
})();
