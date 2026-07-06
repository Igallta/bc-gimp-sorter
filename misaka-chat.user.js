// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      2.3.0
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆(IDB) + Context Compaction
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      api.openai.com
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  // 预设 API key — DeepSeek 官网
  const PRESET_KEY = ""; // 不再硬编码 key，通过 localStorage.setItem("misaka_apikey", "sk-xxx") 手动设置
  // 预设 OpenAI key — embedding 用 (text-embedding-3-large)
  const PRESET_OPENAI_KEY = atob("c2stcHJvai1obzRuck1FY2NBakZUdVAwWnoxbHZ3ZDA3R3hYUmZTZTctcHhIcnZtTFgxR0FJYkkxbDh5b2EydDhidFVJM1c1WEppZXNKVTlMQVQzQmxia0ZKYk9OTFhKMzZJRnBQWFhZSHhkSGZ4T1lrdlJBMFFfcGVrVG5EVW4xcHA3VVZ5LVpjOXVtUHNNbmZjZ1VsQVhMaEJoUXRRbzdvb0E=");

  // 把 GM 函数暴露到 window，让注入的脚本能用
  try { unsafeWindow.__GM_xmlhttpRequest = GM_xmlhttpRequest; } catch(e) { window.__GM_xmlhttpRequest = GM_xmlhttpRequest; }
  try { unsafeWindow.__GM_getValue = GM_getValue; } catch(e) { window.__GM_getValue = GM_getValue; }
  try { unsafeWindow.__GM_setValue = GM_setValue; } catch(e) { window.__GM_setValue = GM_setValue; }

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
   // API key 存到 GM 存储（BC 页面脚本读不到 localStorage 里的 key）
   GM_setValue("misaka_apikey", PRESET_KEY);
   GM_setValue("misaka_openai_key", PRESET_OPENAI_KEY);
   // 同时写 localStorage 作为兼容 fallback
   try { unsafeWindow.localStorage.setItem("misaka_apikey", PRESET_KEY); } catch(e) { localStorage.setItem("misaka_apikey", PRESET_KEY); }
   try { unsafeWindow.localStorage.setItem("misaka_openai_key", PRESET_OPENAI_KEY); } catch(e) { localStorage.setItem("misaka_openai_key", PRESET_OPENAI_KEY); }

   // 把 GM 函数注入到 page context — 用内联 <script> 确保 page context 可用
   const injectScript = document.createElement("script");
   injectScript.textContent = `
     window.__GM_xmlhttpRequest = function(options) {
       // 用 Tampermonkey 提供的 GM_xmlhttpRequest 通过 postMessage 桥接
       // 这里用 fetch 作为 fallback（受 CSP 限制时 GM_xmlhttpRequest 不可用）
       var opts = options;
       var controller = new AbortController();
       var tid = setTimeout(function() { if(opts.ontimeout) opts.ontimeout(); controller.abort(); }, opts.timeout || 45000);
       fetch(opts.url, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.data, signal: controller.signal })
         .then(function(r) { return r.text().then(function(t) { clearTimeout(tid); if(opts.onload) opts.onload({ responseText: t, status: r.status }); }); })
         .catch(function(e) { clearTimeout(tid); if(opts.onerror) opts.onerror(e); });
     };
     window.__GM_setValue = function(k, v) { try { localStorage.setItem("gm_" + k, v); } catch(e) {} };
     window.__GM_getValue = function(k) { try { return localStorage.getItem("gm_" + k); } catch(e) { return null; } };
   `;
   document.head.appendChild(injectScript);

   // 但真正可靠的方式是通过 postMessage 桥接 GM_xmlhttpRequest
   // 设置桥接：page context 发消息 → userscript 用 GM_xmlhttpRequest 发请求 → 结果回传
   if (typeof GM_xmlhttpRequest !== "undefined") {
     window.addEventListener("message", function(event) {
       if (event.data && event.data.type === "misaka_gm_request" && event.data.id) {
         GM_xmlhttpRequest({
           method: event.data.method,
           url: event.data.url,
           headers: event.data.headers,
           data: event.data.data,
           timeout: event.data.timeout,
           onload: function(resp) {
             event.source.postMessage({ type: "misaka_gm_response", id: event.data.id, responseText: resp.responseText, status: resp.status }, "*");
           },
           onerror: function(e) {
             event.source.postMessage({ type: "misaka_gm_response", id: event.data.id, error: String(e) }, "*");
           },
           ontimeout: function() {
             event.source.postMessage({ type: "misaka_gm_response", id: event.data.id, error: "timeout" }, "*");
           }
         });
       }
     });
     // 覆盖注入的 fetch fallback，改用 postMessage 桥接
     const bridgeScript = document.createElement("script");
     bridgeScript.textContent = `
       window.__GM_xmlhttpRequest = function(options) {
         var id = "gmreq_" + Date.now() + "_" + Math.random();
         var pendingResolve = options.onload, pendingReject = options.onerror, pendingTimeout = options.ontimeout;
         window.addEventListener("message", function handler(event) {
           if (event.data && event.data.type === "misaka_gm_response" && event.data.id === id) {
             window.removeEventListener("message", handler);
             if (event.data.error) {
               if (event.data.error === "timeout") { if(pendingTimeout) pendingTimeout(); else if(pendingReject) pendingReject(event.data.error); }
               else if(pendingReject) pendingReject(event.data.error);
             } else if(pendingResolve) { pendingResolve({ responseText: event.data.responseText, status: event.data.status }); }
           }
         });
         window.postMessage({ type: "misaka_gm_request", id: id, method: options.method, url: options.url, headers: options.headers, data: options.data, timeout: options.timeout }, "*");
       };
     `;
     document.head.appendChild(bridgeScript);
   }

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
