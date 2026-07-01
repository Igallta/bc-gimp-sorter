// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      1.0
// @description  御坂 BC 自动回复系统 — 独立 LLM 调用，GM 记忆持久化
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  // 先加载人设文件，再加载主脚本
  function loadScript(url, onload, onerror) {
    const s = document.createElement("script");
    s.src = url;
    s.onload = onload;
    s.onerror = onerror || (() => console.error("[MisakaChat] 加载失败: " + url));
    document.head.appendChild(s);
  }

  function waitForPlayer(cb) {
    if (typeof Player !== "undefined" && Player && Player.MemberNumber === 194331) {
      cb();
    } else {
      setTimeout(() => waitForPlayer(cb), 1000);
    }
  }

  waitForPlayer(() => {
    // 加载人设文件
    loadScript("https://igallta.github.io/bc-gimp-sorter/misaka-persona.js", () => {
      console.log("[MisakaChat] 人设文件已加载");
      // 加载主脚本
      loadScript("https://igallta.github.io/bc-gimp-sorter/misaka-chat.js", () => {
        console.log("[MisakaChat] 主脚本已加载");
      });
    });
  });
})();