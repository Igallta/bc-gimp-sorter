// ==UserScript==
// @name         Misaka iPad WebContent Guard
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      0.3.5
// @description  iPadOS Safari 上为御坂提供跨站 WebContent 回收、原生自动登录与诊断日志
// @match        https://*.bondageprojects.elementfx.com/R*/*
// @match        https://*.bondage-europe.com/R*/*
// @match        https://*.bondageprojects.com/R*/*
// @match        https://*.bondage-asia.com/club/R*
// @match        https://*.bondageclub.com/R*/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @downloadURL  https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.3.5";
  const MEMBER_NUMBER = 194331;
  const LOGIN_NAME = "MSK002";
  const LOGIN_DELAY_MS = 5_000;
  const LOGIN_ENABLED_KEY = "misaka_ipad_guard_login_enabled_v1";
  const LOGIN_PASSWORD_KEY = "misaka_ipad_guard_login_password_v1";
  const ASSET_REVISION = "1378a93";
  const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;

  if (pageWindow.__MisakaIPadGuardLoaderStarted === VERSION) return;
  pageWindow.__MisakaIPadGuardLoaderStarted = VERSION;

  let runtimeLoading = false;
  let autoLoginAttempted = false;
  let loginFailureShown = false;
  let loginDelayScheduled = false;
  let loginDelayElapsed = false;

  function loginConfigured() {
    return GM_getValue(LOGIN_ENABLED_KEY, false) === true &&
      String(GM_getValue(LOGIN_PASSWORD_KEY, "") || "").length > 0;
  }

  function updateLoginStatus(message, kind = "info") {
    let panel = document.getElementById("misaka-ipad-guard-login-status");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "misaka-ipad-guard-login-status";
      Object.assign(panel.style, {
        position: "fixed",
        right: "12px",
        bottom: "12px",
        zIndex: "2147483647",
        maxWidth: "min(560px, calc(100vw - 24px))",
        padding: "10px 12px",
        border: "1px solid #00CCFF",
        borderRadius: "8px",
        background: "rgba(0, 24, 36, 0.92)",
        color: "#00CCFF",
        font: "14px/1.4 sans-serif",
      });
      document.body?.appendChild(panel);
    }
    panel.textContent = `iPadGuard ${VERSION}：${message}`;
    panel.dataset.kind = kind;
  }

  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function maybeAutoLogin() {
    if (pageWindow.CurrentScreen !== "Login" || autoLoginAttempted) return;
    if (!loginConfigured()) {
      updateLoginStatus("自动登录未配置；请从 Tampermonkey 菜单或房间内 /ipadguard login 设置密码");
      return;
    }
    if (!loginDelayElapsed) {
      if (!loginDelayScheduled) {
        loginDelayScheduled = true;
        updateLoginStatus("已返回 BC，等待插件加载；5 秒后自动登录…");
        setTimeout(() => {
          loginDelayElapsed = true;
          maybeAutoLogin();
        }, LOGIN_DELAY_MS);
      }
      return;
    }
    if (pageWindow.ServerIsConnected !== true) {
      updateLoginStatus("等待 BC 登录服务器连接…");
      return;
    }

    const nameInput = document.getElementById("InputName");
    const passwordInput = document.getElementById("InputPassword");
    const loginButton = document.getElementById("login-login-button");
    if (!nameInput || !passwordInput || (typeof pageWindow.LoginDoLogin !== "function" && typeof loginButton?.click !== "function")) {
      updateLoginStatus("等待 BC 原生登录表单…");
      return;
    }

    let password = String(GM_getValue(LOGIN_PASSWORD_KEY, "") || "");
    if (!password) return;
    autoLoginAttempted = true;
    setNativeInputValue(nameInput, LOGIN_NAME);
    setNativeInputValue(passwordInput, password);
    updateLoginStatus(`正在以 ${LOGIN_NAME} 登录…`);

    setTimeout(() => {
      try {
        if (typeof pageWindow.LoginDoLogin === "function") pageWindow.LoginDoLogin(LOGIN_NAME, password);
        else loginButton.click();
      } catch (error) {
        console.error("[iPadGuard] native login failed", error);
        updateLoginStatus("原生登录调用失败；请重新配置或手动登录", "error");
      } finally {
        password = "";
      }
    }, 250);
  }

  function observeLoginResult() {
    if (!autoLoginAttempted || loginFailureShown) return;
    if (pageWindow.CurrentScreen === "ChatRoom") {
      const memberNumber = Number(pageWindow.Player?.MemberNumber || pageWindow.Player?.ID);
      if (memberNumber === MEMBER_NUMBER) {
        document.getElementById("misaka-ipad-guard-login-status")?.remove();
      } else if (memberNumber) {
        loginFailureShown = true;
        updateLoginStatus(`登录后的账号 #${memberNumber} 不是御坂 #${MEMBER_NUMBER}，Guard 不会加载`, "error");
      }
      return;
    }
    if (pageWindow.CurrentScreen !== "Login") return;
    if (pageWindow.LoginSubmitted === true) {
      updateLoginStatus(`已提交 ${LOGIN_NAME} 登录，等待服务器响应…`);
      return;
    }
    if (pageWindow.LoginErrorMessage) {
      loginFailureShown = true;
      updateLoginStatus(`登录失败：${String(pageWindow.LoginErrorMessage).slice(0, 80)}；本页不会自动重试`, "error");
    }
  }

  function closeCredentialDialog() {
    document.getElementById("misaka-ipad-guard-login-config")?.remove();
  }

  function showCredentialDialog() {
    closeCredentialDialog();
    const overlay = document.createElement("div");
    overlay.id = "misaka-ipad-guard-login-config";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "grid",
      placeItems: "center",
      background: "rgba(0, 0, 0, 0.7)",
      font: "16px/1.45 sans-serif",
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      width: "min(460px, calc(100vw - 32px))",
      padding: "18px",
      border: "1px solid #00CCFF",
      borderRadius: "10px",
      background: "#061820",
      color: "#E8FBFF",
    });
    const title = document.createElement("div");
    title.textContent = "iPadGuard 自动登录";
    Object.assign(title.style, { color: "#00CCFF", fontWeight: "700", fontSize: "19px", marginBottom: "12px" });
    const note = document.createElement("div");
    note.textContent = `账号固定为 ${LOGIN_NAME}（登录后校验 #${MEMBER_NUMBER}）。密码会以明文保存在 Tampermonkey 私有数据中，不写入网页存储、URL、日志或仓库。`;
    Object.assign(note.style, { marginBottom: "12px", opacity: "0.9" });
    const passwordInput = document.createElement("input");
    passwordInput.type = "password";
    passwordInput.autocomplete = "current-password";
    passwordInput.placeholder = loginConfigured() ? "已配置；留空可保留现有密码" : "输入 MSK002 的密码";
    Object.assign(passwordInput.style, { width: "100%", boxSizing: "border-box", padding: "10px", marginBottom: "12px" });
    const status = document.createElement("div");
    Object.assign(status.style, { minHeight: "22px", color: "#FFB6B6", marginBottom: "8px" });
    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "8px", flexWrap: "wrap" });
    const makeButton = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", handler);
      Object.assign(button.style, { padding: "8px 12px" });
      buttons.appendChild(button);
      return button;
    };
    makeButton("保存并启用", () => {
      const password = passwordInput.value;
      if (!password && !GM_getValue(LOGIN_PASSWORD_KEY, "")) {
        status.textContent = "密码不能为空。";
        return;
      }
      if (password) GM_setValue(LOGIN_PASSWORD_KEY, password);
      GM_setValue(LOGIN_ENABLED_KEY, true);
      passwordInput.value = "";
      autoLoginAttempted = false;
      loginFailureShown = false;
      loginDelayScheduled = false;
      loginDelayElapsed = false;
      closeCredentialDialog();
      if (pageWindow.CurrentScreen === "Login") maybeAutoLogin();
    });
    makeButton("清除凭据", () => {
      GM_deleteValue(LOGIN_PASSWORD_KEY);
      GM_deleteValue(LOGIN_ENABLED_KEY);
      passwordInput.value = "";
      autoLoginAttempted = false;
      loginFailureShown = false;
      loginDelayScheduled = false;
      loginDelayElapsed = false;
      closeCredentialDialog();
      if (pageWindow.CurrentScreen === "Login") updateLoginStatus("自动登录凭据已清除", "error");
    });
    makeButton("取消", closeCredentialDialog);
    box.append(title, note, passwordInput, status, buttons);
    overlay.appendChild(box);
    document.body?.appendChild(overlay);
    setTimeout(() => passwordInput.focus(), 0);
  }

  function loadRuntime() {
    if (pageWindow.__MisakaIPadGuard || runtimeLoading) return;
    const chatRoomReady =
      typeof pageWindow.bcModSdk !== "undefined" &&
      typeof pageWindow.Player !== "undefined" && !!pageWindow.Player &&
      pageWindow.CurrentScreen === "ChatRoom" &&
      typeof pageWindow.ChatRoomSendChat === "function" &&
      typeof pageWindow.ChatRoomMessage === "function" &&
      Number(pageWindow.Player.MemberNumber || pageWindow.Player.ID) === MEMBER_NUMBER;
    if (!chatRoomReady) return;

    const existing = document.getElementById("misaka-ipad-guard-script");
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.id = "misaka-ipad-guard-script";
    script.dataset.version = VERSION;
    script.dataset.mode = "chatroom";
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
    maybeAutoLogin();
    observeLoginResult();
    loadRuntime();
    setTimeout(tick, 500);
  }

  GM_registerMenuCommand("设置御坂自动登录密码", showCredentialDialog);
  GM_registerMenuCommand("清除御坂自动登录凭据", () => {
    GM_deleteValue(LOGIN_PASSWORD_KEY);
    GM_deleteValue(LOGIN_ENABLED_KEY);
    autoLoginAttempted = false;
    loginFailureShown = false;
    loginDelayScheduled = false;
    loginDelayElapsed = false;
    if (pageWindow.CurrentScreen === "Login") updateLoginStatus("自动登录凭据已清除", "error");
  });
  document.addEventListener("misaka-ipad-guard-open-login-config", showCredentialDialog);
  tick();
})();
