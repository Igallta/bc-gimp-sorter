// Misaka iPad Guard v0.3.4
// iPadOS Safari WebContent 跨站受控回收。与 MisakaChat/GimpSorter 主逻辑完全独立。
(function () {
  "use strict";

  const VERSION = "0.3.4";
  const DISPLAY_NAME = "御坂进程守护";
  const MEMBER_NUMBER = 194331;
  const WCE_LOGIN_NAME = "MSK002";
  const QUICK_LOGIN_LABELS = new Set([
    WCE_LOGIN_NAME.toLowerCase(),
    String(MEMBER_NUMBER),
  ]);
  const RECYCLE_URL = "https://igallta.github.io/bc-gimp-sorter/ipad-recycle.html";
  const CONFIG_KEY = "misaka_ipad_guard_config_v1";
  const LOG_KEY = "misaka_ipad_guard_log_v1";
  const PENDING_KEY = "misaka_ipad_guard_pending_v1";
  const DEFAULTS = Object.freeze({
    enabled: false,
    intervalMinutes: 45,
    quietSeconds: 90,
    maxDeferMinutes: 10,
  });

  if (window.__MisakaIPadGuard) return;

  function isIPad() {
    return /iPad/i.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1);
  }

  function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: source.enabled === true,
      intervalMinutes: clampNumber(source.intervalMinutes, DEFAULTS.intervalMinutes, 15, 240),
      quietSeconds: clampNumber(source.quietSeconds, DEFAULTS.quietSeconds, 15, 600),
      maxDeferMinutes: clampNumber(source.maxDeferMinutes, DEFAULTS.maxDeferMinutes, 1, 60),
    };
  }

  function readJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function safePageLabel() {
    return `${location.hostname}${location.pathname}`;
  }

  function appendLog(type, details) {
    const records = readJSON(LOG_KEY, []);
    const list = Array.isArray(records) ? records : [];
    list.push({
      time: Date.now(),
      type: String(type || "event"),
      details: details && typeof details === "object" ? details : {},
      page: safePageLabel(),
      screen: typeof CurrentScreen === "undefined" ? "unknown" : String(CurrentScreen),
      online: navigator.onLine !== false,
      hidden: document.hidden === true,
    });
    while (list.length > 80) list.shift();
    writeJSON(LOG_KEY, list);
  }

  function getInputText() {
    try {
      if (typeof ElementValue === "function") return String(ElementValue("InputChat") || "").trim();
    } catch (_) {}
    const input = document.getElementById("InputChat");
    return String(input?.value || "").trim();
  }

  function socketConnected() {
    try {
      if (typeof ServerSocket === "undefined" || !ServerSocket) return null;
      return ServerSocket.connected !== false && ServerSocket.disconnected !== true;
    } catch (_) {
      return null;
    }
  }

  function sendLocal(message) {
    try {
      if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return;
      ChatRoomMessage({
        Content: `<font color="#00CCFF">[iPadGuard] ${message}</font>`,
        Type: "LocalMessage",
        Sender: Player.MemberNumber,
      });
    } catch (_) {}
  }

  let loginCapture = null;
  let loginClickScheduled = false;
  let quickLoginAttempted = false;
  let quickLoginResultLogged = false;
  let wrongAccountHandled = false;
  let lastLoginTarget = null;
  let pointerBeforeLogin = null;

  function updateLoginStatus(message, allowRetry = false) {
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
      const text = document.createElement("span");
      text.dataset.role = "message";
      panel.appendChild(text);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.role = "retry";
      retry.textContent = "手动重试";
      Object.assign(retry.style, { marginLeft: "8px", padding: "4px 8px" });
      retry.addEventListener("click", () => {
        if (!lastLoginTarget || !isLoginScreen()) return;
        quickLoginAttempted = false;
        quickLoginResultLogged = false;
        invokeWCEQuickLogin(lastLoginTarget, true);
      });
      panel.appendChild(retry);
      document.body?.appendChild(panel);
    }
    const text = panel.querySelector('[data-role="message"]');
    const retry = panel.querySelector('[data-role="retry"]');
    if (text) text.textContent = `iPadGuard ${VERSION}：${message}`;
    if (retry) retry.style.display = allowRetry ? "inline-block" : "none";
  }

  function isLoginScreen() {
    return typeof CurrentScreen !== "undefined" && CurrentScreen === "Login";
  }

  function normalizeQuickLoginLabel(label) {
    return String(label ?? "").trim().replace(/^#/, "").toLowerCase();
  }

  function restoreDrawButtonCapture() {
    if (!loginCapture) return;
    if (window.DrawButton === loginCapture.wrapper) window.DrawButton = loginCapture.original;
    loginCapture = null;
  }

  function installDrawButtonCapture() {
    if (loginCapture || quickLoginAttempted || !isLoginScreen()) return;
    if (typeof window.DrawButton !== "function") return;

    const original = window.DrawButton;
    const state = { original, wrapper: null, target: null };
    state.wrapper = function (x, y, width, height, label, ...rest) {
      if (
        !state.target &&
        QUICK_LOGIN_LABELS.has(normalizeQuickLoginLabel(label)) &&
        Number.isFinite(Number(x)) && Number.isFinite(Number(y)) &&
        Number(width) > 0 && Number(height) > 0
      ) {
        state.target = {
          x: Number(x), y: Number(y), width: Number(width), height: Number(height),
          label: String(label),
        };
        lastLoginTarget = { ...state.target };
        appendLog("wce-quick-login-found", { label: String(label) });
        updateLoginStatus(`已找到 WCE 账号 ${String(label)}，准备登录…`);
      }
      return original.call(this, x, y, width, height, label, ...rest);
    };
    loginCapture = state;
    window.DrawButton = state.wrapper;
    appendLog("wce-quick-login-wait", {
      loginName: WCE_LOGIN_NAME,
      memberNumber: MEMBER_NUMBER,
    });
  }

  function currentLoginClickHandlers() {
    const handlers = [];
    const seen = new Set();
    const add = (fn, receiver, source) => {
      if (typeof fn !== "function" || seen.has(fn)) return;
      seen.add(fn);
      handlers.push({ fn, receiver, source });
    };
    const screenFunctions = window.CurrentScreenFunctions;
    add(screenFunctions?.Click, screenFunctions, "CurrentScreenFunctions.Click");
    add(window.LoginClick, window, "LoginClick");
    return handlers;
  }

  function dispatchCanvasLoginClick(target) {
    const canvas = window.MainCanvas?.canvas || document.getElementById("MainCanvas");
    if (!canvas || typeof canvas.dispatchEvent !== "function") return false;
    try {
      const rect = typeof canvas.getBoundingClientRect === "function"
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0, width: 2000, height: 1000 };
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + (target.x + target.width / 2) * rect.width / 2000,
        clientY: rect.top + (target.y + target.height / 2) * rect.height / 1000,
      };
      const event = typeof MouseEvent === "function"
        ? new MouseEvent("click", eventOptions)
        : new Event("click", { bubbles: true, cancelable: true });
      canvas.dispatchEvent(event);
      return true;
    } catch (error) {
      appendLog("wce-canvas-click-error", { error: String(error).slice(0, 120) });
      return false;
    }
  }

  function restoreLoginPointer() {
    if (!pointerBeforeLogin) return;
    window.MouseX = pointerBeforeLogin.x;
    window.MouseY = pointerBeforeLogin.y;
    pointerBeforeLogin = null;
  }

  function invokeWCEQuickLogin(target, manual = false) {
    if (quickLoginAttempted || !isLoginScreen()) return;
    const handlers = currentLoginClickHandlers();
    const sources = [];
    pointerBeforeLogin = { x: window.MouseX, y: window.MouseY };
    quickLoginAttempted = true;
    window.MouseX = target.x + target.width / 2;
    window.MouseY = target.y + target.height / 2;

    try {
      for (const handler of handlers) {
        sources.push(handler.source);
        handler.fn.call(handler.receiver, typeof Event === "function" ? new Event("click") : undefined);
        if (window.LoginSubmitted === true || !isLoginScreen()) break;
      }
      if (window.LoginSubmitted !== true && isLoginScreen() && dispatchCanvasLoginClick(target)) {
        sources.push("MainCanvas.click");
      }
      appendLog("wce-quick-login-attempt", {
        memberNumber: MEMBER_NUMBER,
        loginName: WCE_LOGIN_NAME,
        handlers: sources,
        manual,
      });
      updateLoginStatus(`已触发快速登录（${sources.join(" + ") || "无可用点击入口"}），等待结果…`);
    } catch (error) {
      quickLoginResultLogged = true;
      appendLog("wce-quick-login-error", { error: String(error).slice(0, 120) });
      updateLoginStatus(`触发失败：${String(error).slice(0, 80)}`, true);
    }

    setTimeout(() => {
      if (!isLoginScreen() || window.LoginSubmitted === true) return;
      restoreLoginPointer();
      appendLog("wce-quick-login-no-effect", { handlers: sources, manual });
      updateLoginStatus("点击已执行，但登录未开始", true);
    }, 2000);
  }

  function scheduleWCEQuickLogin() {
    if (!loginCapture?.target || loginClickScheduled || quickLoginAttempted || !isLoginScreen()) return;
    if (currentLoginClickHandlers().length === 0 && !document.getElementById("MainCanvas")) return;

    loginClickScheduled = true;
    const target = { ...loginCapture.target };
    restoreDrawButtonCapture();
    setTimeout(() => {
      loginClickScheduled = false;
      if (quickLoginAttempted || !isLoginScreen()) return;
      invokeWCEQuickLogin(target, false);
    }, 250);
  }

  function observeQuickLoginResult() {
    if (!quickLoginAttempted || quickLoginResultLogged) return;
    const memberNumber = Number(window.Player?.MemberNumber || window.Player?.ID);
    if (memberNumber === MEMBER_NUMBER && !isLoginScreen()) {
      quickLoginResultLogged = true;
      restoreLoginPointer();
      appendLog("wce-quick-login-success", { memberNumber });
      return;
    }
    if (!wrongAccountHandled && memberNumber && memberNumber !== MEMBER_NUMBER && !isLoginScreen()) {
      wrongAccountHandled = true;
      quickLoginResultLogged = true;
      restoreLoginPointer();
      appendLog("unexpected-account", { memberNumber });
      alert(`iPadGuard：WCE 快速登录后的账号 #${memberNumber} 不是御坂 #${MEMBER_NUMBER}，Guard 不会加载。`);
      return;
    }
    if (isLoginScreen() && window.LoginSubmitted === false && window.LoginErrorMessage) {
      quickLoginResultLogged = true;
      restoreLoginPointer();
      appendLog("wce-quick-login-failed", { error: String(window.LoginErrorMessage).slice(0, 100) });
      updateLoginStatus(`WCE 登录失败：${String(window.LoginErrorMessage).slice(0, 80)}`, true);
    }
  }

  function initLoginRecovery() {
    if (window.__MisakaIPadGuardLoginRecovery?.version === VERSION) return;
    let loginTimer = null;
    const marker = {
      version: VERSION,
      dispose() {
        if (loginTimer) clearInterval(loginTimer);
        loginTimer = null;
        restoreDrawButtonCapture();
        restoreLoginPointer();
        document.getElementById("misaka-ipad-guard-login-status")?.remove();
        if (window.__MisakaIPadGuardLoginRecovery === marker) {
          delete window.__MisakaIPadGuardLoginRecovery;
        }
      },
    };
    window.__MisakaIPadGuardLoginRecovery = marker;

    const tickLogin = () => {
      if (!isLoginScreen()) {
        observeQuickLoginResult();
        marker.dispose();
        return;
      }
      installDrawButtonCapture();
      scheduleWCEQuickLogin();
      observeQuickLoginResult();
    };
    loginTimer = setInterval(tickLogin, 100);
    updateLoginStatus("页面 runtime 已加载，等待 WCE 快速登录按钮…");
    tickLogin();
    console.log(`[iPadGuard] v${VERSION} login recovery ready`);
  }

  let config = normalizeConfig(readJSON(CONFIG_KEY, {}));
  let startedAt = Date.now();
  let lastActivityAt = Date.now();
  let nextRecycleAt = startedAt + config.intervalMinutes * 60_000;
  let dueSince = 0;
  let lastDeferralReason = "";
  let lastTimerTick = Date.now();
  let timer = null;

  function persistConfig() {
    writeJSON(CONFIG_KEY, config);
  }

  function recycle(reason) {
    const returnUrl = location.href;
    const pending = {
      startedAt: Date.now(),
      reason: String(reason || "manual"),
      returnPage: safePageLabel(),
      version: VERSION,
    };
    writeJSON(PENDING_KEY, pending);
    appendLog("recycle-start", pending);
    // 先离开 BC origin，迫使 Safari 丢弃旧站点的 WebContent；trampoline
    // 随后返回原地址。若 BC 落在登录页，油猴 loader 会读取 GM 私有存储
    // 中的密码并调用 BC 原生登录，再由 ReturnToChatRoom 自动回房。
    window.addEventListener("unload", () => {}, { once: true });
    const target = `${RECYCLE_URL}#return=${encodeURIComponent(returnUrl)}&started=${Date.now()}`;
    location.replace(target);
  }

  function evaluateBlockReason(now) {
    if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return "not-in-room";
    if (navigator.onLine === false) return "offline";
    if (window.__misakaReplyInProgress || window.__misakaGlobalBusy) return "misaka-busy";
    if (getInputText()) return "typing";
    if (now - lastActivityAt < config.quietSeconds * 1000) return "room-active";
    return "";
  }

  function checkSchedule(now) {
    if (!config.enabled || now < nextRecycleAt) return;
    if (!dueSince) dueSince = now;

    const blockReason = evaluateBlockReason(now);
    const maxDeferAt = dueSince + config.maxDeferMinutes * 60_000;
    if (blockReason && now < maxDeferAt) {
      if (blockReason !== lastDeferralReason) {
        appendLog("recycle-deferred", { reason: blockReason });
        lastDeferralReason = blockReason;
      }
      return;
    }
    if (blockReason === "misaka-busy" || blockReason === "typing" || blockReason === "not-in-room") return;
    recycle(blockReason ? `deadline:${blockReason}` : "scheduled");
  }

  function onTick() {
    const now = Date.now();
    const driftMs = now - lastTimerTick - 15_000;
    if (driftMs > 10_000) appendLog("timer-drift", { driftMs });
    lastTimerTick = now;
    checkSchedule(now);
  }

  function minutesUntil(timestamp) {
    return Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  }

  function handleCommand(message) {
    const raw = String(message || "").trim();
    if (!raw.startsWith("/ipadguard")) return false;
    const parts = raw.slice("/ipadguard".length).trim().split(/\s+/).filter(Boolean);
    const sub = String(parts[0] || "status").toLowerCase();

    if (sub === "on") {
      config.enabled = true;
      nextRecycleAt = Date.now() + config.intervalMinutes * 60_000;
      dueSince = 0;
      persistConfig();
      appendLog("enabled", { intervalMinutes: config.intervalMinutes });
      sendLocal(`✅ 已开启：自动回收 | 下次回收：${config.intervalMinutes}分钟后`);
    } else if (sub === "off") {
      config.enabled = false;
      persistConfig();
      appendLog("disabled", {});
      sendLocal("⏹ 已关闭：自动回收");
    } else if (sub === "interval") {
      const value = clampNumber(parts[1], NaN, 15, 240);
      if (!Number.isFinite(value)) {
        sendLocal("用法：/ipadguard interval <15-240分钟>");
      } else {
        config.intervalMinutes = value;
        nextRecycleAt = Date.now() + value * 60_000;
        dueSince = 0;
        persistConfig();
        appendLog("interval-changed", { intervalMinutes: value });
        sendLocal(`✅ 已设置：自动回收间隔 | 间隔：${value}分钟`);
      }
    } else if (sub === "login") {
      document.dispatchEvent(new Event("misaka-ipad-guard-open-login-config"));
      sendLocal("✅ 已打开：自动登录配置 | 账号：MSK002 | 登录校验：#194331");
    } else if (sub === "recycle") {
      sendLocal("已安排手动回收：2秒后执行");
      setTimeout(() => recycle("manual"), 2000);
    } else if (sub === "log") {
      const records = readJSON(LOG_KEY, []);
      window.__misakaIPadGuardLogExport = JSON.stringify(records, null, 2);
      sendLocal(`✅ 已导出诊断日志 | 数量：${Array.isArray(records) ? records.length : 0} | 位置：window.__misakaIPadGuardLogExport`);
    } else if (sub === "clear") {
      localStorage.removeItem(LOG_KEY);
      sendLocal("✅ 已清空：诊断日志");
    } else if (sub === "status") {
      sendLocal(`状态：${config.enabled ? "开启" : "关闭"} | 间隔：${config.intervalMinutes}分钟 | 下次回收：${minutesUntil(nextRecycleAt)}分钟 | 连接：${socketConnected() === false ? "断开" : "正常"}`);
    } else {
      sendLocal("用法：/ipadguard on|off|status|recycle|interval <分钟>|login|log|clear");
    }
    return true;
  }

  function commandFromSendArgs(args) {
    // BC 的 ChatRoomSendChat 通常直接读取 InputChat；移动端传入的 args[0]
    // 可能为空或是其他字符串。始终优先读取真实输入框，避免命令漏给 BC。
    const input = getInputText();
    if (input) return input;
    return typeof args?.[0] === "string" ? String(args[0]).trim() : "";
  }

  function consumeCommand(args) {
    const message = commandFromSendArgs(args);
    if (!message.startsWith("/ipadguard") || !handleCommand(message)) return false;
    try { ElementValue("InputChat", ""); } catch (_) {
      const input = document.getElementById("InputChat");
      if (input) input.value = "";
    }
    return true;
  }

  function installHooks() {
    const existing = bcModSdk.getModsInfo().find((entry) => entry.name === "MisakaIPadGuard");
    const mod = existing
      ? { hookFunction: () => {} }
      : bcModSdk.registerMod({
          name: "MisakaIPadGuard",
          fullName: "Misaka iPad WebContent Guard",
          version: VERSION,
          repository: "https://github.com/Igallta/bc-gimp-sorter",
        });

    mod.hookFunction("ChatRoomMessage", 20, (args, next) => {
      const data = args?.[0];
      if (data && data.Type !== "LocalMessage") lastActivityAt = Date.now();
      return next(args);
    });

    mod.hookFunction("ChatRoomSendChat", 20, (args, next) => {
      if (consumeCommand(args)) return;
      return next(args);
    });

    // iPad/Safari 上 bcModSdk 的发送 hook 偶尔没有接到移动端按钮路径。
    // 再包装页面实际入口；普通聊天仍原样交给 SDK 链和 BC。
    if (!window.__misakaIPadGuardSendWrapped && typeof window.ChatRoomSendChat === "function") {
      const originalSend = window.ChatRoomSendChat;
      window.__misakaIPadGuardOriginalSend = originalSend;
      window.ChatRoomSendChat = function () {
        if (consumeCommand(Array.from(arguments))) return;
        return originalSend.apply(this, arguments);
      };
      window.__misakaIPadGuardSendWrapped = true;
    }
  }

  function installLifecycleLogging() {
    window.addEventListener("online", () => appendLog("online", {}));
    window.addEventListener("offline", () => appendLog("offline", {}));
    window.addEventListener("pagehide", (event) => appendLog("pagehide", { persisted: !!event.persisted }));
    window.addEventListener("pageshow", (event) => appendLog("pageshow", { persisted: !!event.persisted }));
    document.addEventListener("visibilitychange", () => appendLog("visibility", { state: document.visibilityState }));
    window.addEventListener("error", (event) => appendLog("window-error", { message: String(event.message || "unknown").slice(0, 300) }));
    window.addEventListener("unhandledrejection", (event) => appendLog("unhandled-rejection", { message: String(event.reason?.message || event.reason || "unknown").slice(0, 300) }));
  }

  function init() {
    const pending = readJSON(PENDING_KEY, null);
    if (pending) {
      appendLog("recycle-return", { elapsedMs: Date.now() - Number(pending.startedAt || Date.now()), reason: pending.reason || "unknown" });
      localStorage.removeItem(PENDING_KEY);
    }
    appendLog("runtime-start", { version: VERSION, iPad: isIPad() });
    installLifecycleLogging();
    installHooks();
    timer = setInterval(onTick, 15_000);
    window.__MisakaIPadGuard = {
      version: VERSION,
      get config() { return { ...config }; },
      get startedAt() { return startedAt; },
      get lastActivityAt() { return lastActivityAt; },
      get nextRecycleAt() { return nextRecycleAt; },
      handleCommand,
      recycle,
      dispose() {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
    window.__MisakaIPadGuardTestHooks = { normalizeConfig, evaluateBlockReason };
    console.log(`[iPadGuard] v${VERSION} ready; auto recycle ${config.enabled ? "on" : "off"}`);
    sendLocal(`${DISPLAY_NAME} ${VERSION} 已加载`);
  }

  if (typeof Player === "undefined" || Number(Player?.MemberNumber || Player?.ID) !== MEMBER_NUMBER) return;
  if (typeof bcModSdk === "undefined") return;
  init();
})();
