// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      2.3.5
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆(IDB) + 房间上下文
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
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
  // localStorage.setItem("misaka_openai_key", "sk-xxx")

  // 把 GM 函数暴露到 window，让注入的脚本能用
  try { window.__GM_xmlhttpRequest = GM_xmlhttpRequest; } catch(e) {}
  try { window.__GM_getValue = GM_getValue; } catch(e) {}
  try { window.__GM_setValue = GM_setValue; } catch(e) {}

  const SCRIPT_VERSION = "2.3.5";
  const BASE_URL = "https://igallta.github.io/bc-gimp-sorter";

  function waitForReady(cb, attempts) {
    attempts = attempts || 0;
    if (typeof Player !== "undefined" && Player && Player.MemberNumber === 194331 &&
        typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
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
