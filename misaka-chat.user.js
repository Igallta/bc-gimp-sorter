// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      2.1.0
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆 + Context Compaction
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  // 预设 API key — DeepSeek 官网
  const PRESET_KEY = atob("c2stOWI3MjAyYmMwNTI0NGMxMDkwN2Q5NzdkMjI5YWEzNGQ=");

  // 把 GM_xmlhttpRequest 暴露到 window，让注入的脚本能用
  window.__GM_xmlhttpRequest = GM_xmlhttpRequest;

  // 预设 API key 到 localStorage
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
    // 强制更新 API key（覆盖旧的 OpenRouter key）
    localStorage.setItem("misaka_apikey", PRESET_KEY);
    
    // 设置 OpenAI key（用于 embedding 语义搜索）
    // 手动设置：在 BC 控制台跑 localStorage.setItem("misaka_openai_key", "sk-proj-xxx")
    if (!localStorage.getItem("misaka_openai_key")) {
      console.log("[MisakaChat] 提示: 未设置 OpenAI key，语义搜索将不可用。在控制台运行: localStorage.setItem('misaka_openai_key', 'sk-proj-xxx')");
    }

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
