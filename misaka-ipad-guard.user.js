// ==UserScript==
// @name         Misaka iPad WebContent Guard
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      0.1.0
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

  const VERSION = "0.1.0";
  const MEMBER_NUMBER = 194331;
  if (window.__MisakaIPadGuardLoaderStarted) return;
  window.__MisakaIPadGuardLoaderStarted = VERSION;

  function load(attempt) {
    if (window.__MisakaIPadGuard) return;
    if (typeof bcModSdk === "undefined" || typeof Player === "undefined" || !Player) {
      if (attempt < 1200) setTimeout(() => load(attempt + 1), 500);
      return;
    }
    if (Number(Player.MemberNumber || Player.ID) !== MEMBER_NUMBER) return;
    if (document.getElementById("misaka-ipad-guard-script")) return;

    const script = document.createElement("script");
    script.id = "misaka-ipad-guard-script";
    script.dataset.version = VERSION;
    script.src = `https://igallta.github.io/bc-gimp-sorter/misaka-ipad-guard.js?v=${VERSION}`;
    script.onload = () => console.log(`[iPadGuard] runtime ${VERSION} loaded`);
    script.onerror = () => console.error("[iPadGuard] runtime load failed");
    document.head.appendChild(script);
  }

  load(0);
})();
