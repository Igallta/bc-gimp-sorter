// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      2.3.1
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆(IDB) + Context Compaction
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
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
  // localStorage.setItem("misaka_openai_key", "sk-xxx")

  // 把 GM 函数暴露到 window，让注入的脚本能用
  try { window.__GM_xmlhttpRequest = GM_xmlhttpRequest; } catch(e) {}
  try { window.__GM_getValue = GM_getValue; } catch(e) {}
  try { window.__GM_setValue = GM_setValue; } catch(e) {}

  function waitForReady(cb, attempts) {
    attempts = attempts || 0;
    if (attempts > 60) {
      console.error("[MisakaChat] 等待游戏超时");
      return;
    }
    if (typeof Player !== "undefined" && Player && Player.MemberNumber === 194331 &&
        typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
      cb();
    } else {
      setTimeout(() => waitForReady(cb, attempts + 1), 1000);
    }
  }

  function loadScript(url, onload, onerror) {
    const s = document.createElement("script");
    s.src = url;
    s.onload = onload;
    s.onerror = onerror || (() => console.error("[MisakaChat] 加载失败: " + url));
    document.head.appendChild(s);
  }

  waitForReady(() => {
    // 加载人设文件
    loadScript("https://cdn.jsdelivr.net/gh/Igallta/bc-gimp-sorter@latest/misaka-persona.js", () => {
      console.log("[MisakaChat] 人设文件已加载");
      // 加载主脚本
      loadScript("https://cdn.jsdelivr.net/gh/Igallta/bc-gimp-sorter@latest/misaka-chat.js", () => {
        console.log("[MisakaChat] 主脚本已加载");
      });
    });
  });
})();