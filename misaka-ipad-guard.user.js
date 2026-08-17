// ==UserScript==
// @name         Misaka iPad WebContent Guard
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      0.2.0
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

  const VERSION = "0.2.0";
  const MEMBER_NUMBER = 194331;
  const QUICK_LOGIN_LABEL = String(MEMBER_NUMBER);
  const ASSET_REVISION = "f6fb623";
  const LOG_KEY = "misaka_ipad_guard_log_v1";
  const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;

  if (pageWindow.__MisakaIPadGuardLoaderStarted === VERSION) return;
  pageWindow.__MisakaIPadGuardLoaderStarted = VERSION;

  let runtimeLoading = false;
  let capture = null;
  let clickScheduled = false;
  let quickLoginAttempted = false;
  let quickLoginResultLogged = false;
  let wrongAccountHandled = false;

  function appendBootstrapLog(type, details) {
    try {
      const raw = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
      const records = Array.isArray(raw) ? raw : [];
      records.push({
        time: Date.now(),
        type: String(type || "loader-event"),
        details: details && typeof details === "object" ? details : {},
        page: `${location.hostname}${location.pathname}`,
        screen: typeof pageWindow.CurrentScreen === "undefined" ? "unknown" : String(pageWindow.CurrentScreen),
        online: navigator.onLine !== false,
        hidden: document.hidden === true,
      });
      while (records.length > 80) records.shift();
      localStorage.setItem(LOG_KEY, JSON.stringify(records));
    } catch (_) {}
  }

  function isLoginScreen() {
    return pageWindow.CurrentModule === "Character" && pageWindow.CurrentScreen === "Login";
  }

  function normalizeQuickLoginLabel(label) {
    return String(label ?? "").trim().replace(/^#/, "");
  }

  function restoreDrawButtonCapture() {
    if (!capture) return;
    if (pageWindow.DrawButton === capture.wrapper) pageWindow.DrawButton = capture.original;
    capture = null;
  }

  function installDrawButtonCapture() {
    if (capture || quickLoginAttempted || !isLoginScreen()) return;
    if (typeof pageWindow.DrawButton !== "function" || typeof pageWindow.LoginClick !== "function") return;

    const original = pageWindow.DrawButton;
    const state = { original, wrapper: null, target: null, installedAt: Date.now() };
    state.wrapper = function (x, y, width, height, label, ...rest) {
      if (
        !state.target &&
        normalizeQuickLoginLabel(label) === QUICK_LOGIN_LABEL &&
        Number.isFinite(Number(x)) && Number.isFinite(Number(y)) &&
        Number(width) > 0 && Number(height) > 0
      ) {
        state.target = {
          x: Number(x), y: Number(y), width: Number(width), height: Number(height),
          label: String(label),
        };
        appendBootstrapLog("wce-quick-login-found", { label: String(label) });
      }
      return original.call(this, x, y, width, height, label, ...rest);
    };
    capture = state;
    pageWindow.DrawButton = state.wrapper;
    appendBootstrapLog("wce-quick-login-wait", { memberNumber: MEMBER_NUMBER });
  }

  function scheduleWCEQuickLogin() {
    if (!capture?.target || clickScheduled || quickLoginAttempted || !isLoginScreen()) return;
    clickScheduled = true;
    const target = { ...capture.target };
    restoreDrawButtonCapture();
    setTimeout(() => {
      clickScheduled = false;
      if (quickLoginAttempted || !isLoginScreen() || typeof pageWindow.LoginClick !== "function") return;

      const previousX = pageWindow.MouseX;
      const previousY = pageWindow.MouseY;
      quickLoginAttempted = true;
      pageWindow.MouseX = target.x + target.width / 2;
      pageWindow.MouseY = target.y + target.height / 2;
      appendBootstrapLog("wce-quick-login-attempt", { memberNumber: MEMBER_NUMBER });
      try {
        // 走 WCE 已 hook 的 BC 原生 LoginClick。WCE 自己读取并解密已保存账号，
        // Guard 不读取、复制或保存密码。
        pageWindow.LoginClick();
      } catch (error) {
        quickLoginResultLogged = true;
        appendBootstrapLog("wce-quick-login-error", { error: String(error).slice(0, 120) });
      } finally {
        pageWindow.MouseX = previousX;
        pageWindow.MouseY = previousY;
      }
    }, 250);
  }

  function attemptWCEQuickLogin() {
    if (!isLoginScreen() || quickLoginAttempted) {
      if (!isLoginScreen()) restoreDrawButtonCapture();
      return;
    }
    installDrawButtonCapture();
    scheduleWCEQuickLogin();
  }

  function observeQuickLoginResult() {
    if (!quickLoginAttempted || quickLoginResultLogged) return;
    const memberNumber = Number(pageWindow.Player?.MemberNumber || pageWindow.Player?.ID);
    if (memberNumber === MEMBER_NUMBER && pageWindow.CurrentScreen !== "Login") {
      quickLoginResultLogged = true;
      appendBootstrapLog("wce-quick-login-success", { memberNumber });
      return;
    }
    if (!wrongAccountHandled && memberNumber && memberNumber !== MEMBER_NUMBER && pageWindow.CurrentScreen !== "Login") {
      wrongAccountHandled = true;
      quickLoginResultLogged = true;
      appendBootstrapLog("unexpected-account", { memberNumber });
      alert(`iPadGuard：WCE 快速登录后的账号 #${memberNumber} 不是御坂 #${MEMBER_NUMBER}，Guard 不会加载。`);
      return;
    }
    if (isLoginScreen() && pageWindow.LoginSubmitted === false && pageWindow.LoginErrorMessage) {
      quickLoginResultLogged = true;
      appendBootstrapLog("wce-quick-login-failed", { error: String(pageWindow.LoginErrorMessage).slice(0, 100) });
    }
  }

  function loadRuntime() {
    if (pageWindow.__MisakaIPadGuard || runtimeLoading) return;
    if (typeof pageWindow.bcModSdk === "undefined" ||
        typeof pageWindow.Player === "undefined" || !pageWindow.Player ||
        pageWindow.CurrentScreen !== "ChatRoom" ||
        typeof pageWindow.ChatRoomSendChat !== "function" ||
        typeof pageWindow.ChatRoomMessage !== "function") return;
    if (Number(pageWindow.Player.MemberNumber || pageWindow.Player.ID) !== MEMBER_NUMBER) return;

    const existing = document.getElementById("misaka-ipad-guard-script");
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.id = "misaka-ipad-guard-script";
    script.dataset.version = VERSION;
    script.src = `https://raw.githack.com/Igallta/bc-gimp-sorter/${ASSET_REVISION}/misaka-ipad-guard.js?v=${VERSION}`;
    runtimeLoading = true;
    script.onload = () => {
      runtimeLoading = false;
      if (pageWindow.__MisakaIPadGuard) {
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
    attemptWCEQuickLogin();
    observeQuickLoginResult();
    loadRuntime();
    setTimeout(tick, 500);
  }

  tick();
})();
