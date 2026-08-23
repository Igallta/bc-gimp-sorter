// ==UserScript==
// @name         BC Misaka Auto Chat
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      3.3.1
// @description  御坂 BC 自动回复系统 — LLM 驱动 + 语义记忆(IDB) + 房间上下文
// @match        https://*.bondageprojects.elementfx.com/R*/*
// @match        https://*.bondage-europe.com/R*/*
// @match        https://*.bondageprojects.com/R*/*
// @match        https://*.bondage-asia.com/club/R*
// @match        https://*.bondageclub.com/R*/*
// @match        http://localhost:*/*
// @updateURL    https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-chat.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      misaka-diagnostics.misaka-diagnostics.workers.dev
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const SCRIPT_VERSION = "3.3.1";

  // 模型密钥只留在 Tampermonkey 私有存储。页面运行时只能查询是否存在、
  // 覆盖/删除指定密钥，以及让 loader 代发到固定 API 的请求，不能读取明文。
  try {
    const runtimeSecretKeys = new Set(["misaka_apikey", "misaka_openrouter_key"]);
    const requestKinds = {
      deepseek: {
        key: "misaka_apikey",
        urls: new Set([
          "https://api.deepseek.com/chat/completions",
          "https://api.deepseek.com/beta/chat/completions",
          "https://api.deepseek.com/responses",
        ]),
      },
      "openrouter-embedding": {
        key: "misaka_openrouter_key",
        urls: new Set(["https://openrouter.ai/api/v1/embeddings"]),
      },
    };
    pageWindow.__misakaHasSecret = key => {
      if (!runtimeSecretKeys.has(String(key || ""))) return false;
      return Boolean(String(GM_getValue(key, "") || "").trim());
    };
    pageWindow.__misakaSetSecret = (key, value) => {
      if (!runtimeSecretKeys.has(String(key || ""))) return false;
      const secret = String(value || "").trim();
      if (!secret) return false;
      GM_setValue(key, secret);
      return true;
    };
    pageWindow.__misakaDeleteSecret = key => {
      if (!runtimeSecretKeys.has(String(key || ""))) return false;
      GM_deleteValue(key);
      return true;
    };
    pageWindow.__misakaPrivateRequest = spec => new Promise(resolve => {
      try {
        const kind = requestKinds[String(spec?.kind || "")];
        const url = String(spec?.url || "");
        if (!kind || !kind.urls.has(url)) {
          resolve({ status: 0, responseText: "", error: "request-not-allowed" });
          return;
        }
        const secret = String(GM_getValue(kind.key, "") || "").trim();
        if (!secret) {
          resolve({ status: 0, responseText: "", error: "missing-api-key" });
          return;
        }
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + secret,
          },
          data: String(spec?.data || ""),
          timeout: Math.min(600_000, Math.max(1_000, Number(spec?.timeout) || 15_000)),
          onload: response => resolve({
            status: Number(response.status || 0),
            responseText: String(response.responseText || ""),
            error: "",
          }),
          onerror: () => resolve({ status: 0, responseText: "", error: "network-error" }),
          ontimeout: () => resolve({ status: 0, responseText: "", error: "timeout" }),
        });
      } catch (error) {
        resolve({ status: 0, responseText: "", error: "bridge-error" });
      }
    });
  } catch(e) {}

  const DIAGNOSTIC_ENDPOINT = "https://misaka-diagnostics.misaka-diagnostics.workers.dev/v1/reply-failures";
  const DIAGNOSTIC_UPLOAD_EVENT = "misaka-diagnostics-upload-v1";
  const DIAGNOSTIC_CONFIG_EVENT = "misaka-diagnostics-config-open-v1";
  const DIAGNOSTIC_SECRET_KEY = "misaka_diagnostics_upload_secret_v1";
  const DIAGNOSTIC_PENDING_KEY = "misaka_diagnostics_pending_v1";
  const DIAGNOSTIC_PENDING_LIMIT = 5;
  const SHADOW_EVENT_ENDPOINT = "https://misaka-diagnostics.misaka-diagnostics.workers.dev/v1/shadow/events";
  const SHADOW_LEGACY_ENDPOINT = "https://misaka-diagnostics.misaka-diagnostics.workers.dev/v1/shadow/legacy";
  const SHADOW_EVENT = "misaka-shadow-event-v1";
  const SHADOW_LEGACY_EVENT = "misaka-shadow-legacy-v1";
  const SHADOW_ENABLED_KEY = "misaka_shadow_enabled_v1";
  const SHADOW_PENDING_KEY = "misaka_shadow_pending_v1";
  const SHADOW_INSTALLATION_KEY = "misaka_shadow_installation_v1";
  const SHADOW_PSEUDONYM_SALT_KEY = "misaka_shadow_pseudonym_salt_v1";
  const SHADOW_PENDING_LIMIT = 20;
  let diagnosticUploadBusy = false;
  let shadowUploadBusy = false;

  function diagnosticSecret() {
    try { return String(GM_getValue(DIAGNOSTIC_SECRET_KEY, "") || ""); }
    catch (e) { return ""; }
  }

  pageWindow.__misakaDiagnosticsConfigured = () => diagnosticSecret().length >= 24;

  function readDiagnosticPending() {
    try {
      const value = GM_getValue(DIAGNOSTIC_PENDING_KEY, []);
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed.slice(-DIAGNOSTIC_PENDING_LIMIT) : [];
    } catch (e) { return []; }
  }

  function writeDiagnosticPending(records) {
    try { GM_setValue(DIAGNOSTIC_PENDING_KEY, records.slice(-DIAGNOSTIC_PENDING_LIMIT)); }
    catch (e) {}
  }

  async function signDiagnosticBody(secret, timestamp, body) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
    return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function uploadSignedEnvelope(url, envelope, secret) {
    return new Promise(async (resolve) => {
      try {
        const body = JSON.stringify(envelope);
        if (new TextEncoder().encode(body).length > 65_536) return resolve(false);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signDiagnosticBody(secret, timestamp, body);
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            "X-Misaka-Timestamp": timestamp,
            "X-Misaka-Signature": `v1=${signature}`,
          },
          data: body,
          timeout: 15_000,
          onload(response) {
            let result = null;
            try { result = JSON.parse(response.responseText || "{}"); } catch (e) {}
            resolve(response.status === 200 && result?.ok === true);
          },
          onerror() { resolve(false); },
          ontimeout() { resolve(false); },
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  function uploadDiagnosticEnvelope(envelope, secret) {
    return uploadSignedEnvelope(DIAGNOSTIC_ENDPOINT, envelope, secret);
  }

  async function flushDiagnosticPending() {
    if (diagnosticUploadBusy) return;
    const secret = diagnosticSecret();
    if (secret.length < 24) return;
    diagnosticUploadBusy = true;
    try {
      const pending = readDiagnosticPending();
      const remaining = [];
      for (const envelope of pending) {
        if (!await uploadDiagnosticEnvelope(envelope, secret)) remaining.push(envelope);
      }
      writeDiagnosticPending(remaining);
      if (pending.length > remaining.length) {
        console.log(`[MisakaChat] 已上传 ${pending.length - remaining.length} 个回复故障包`);
      }
    } finally {
      diagnosticUploadBusy = false;
    }
  }

  function enqueueDiagnosticEnvelope(envelope) {
    if (!envelope || envelope.protocol !== "misaka.upload.v1") return;
    const pending = readDiagnosticPending();
    pending.push(envelope);
    writeDiagnosticPending(pending);
    void flushDiagnosticPending();
  }

  function shadowEnabled() {
    try { return GM_getValue(SHADOW_ENABLED_KEY, false) === true; }
    catch (e) { return false; }
  }

  function readShadowPending() {
    try {
      const value = GM_getValue(SHADOW_PENDING_KEY, []);
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed.slice(-SHADOW_PENDING_LIMIT) : [];
    } catch (e) { return []; }
  }

  function writeShadowPending(records) {
    try { GM_setValue(SHADOW_PENDING_KEY, records.slice(-SHADOW_PENDING_LIMIT)); }
    catch (e) {}
  }

  function shadowInstallationId() {
    try {
      let value = String(GM_getValue(SHADOW_INSTALLATION_KEY, "") || "");
      if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) {
        value = `install-${crypto.randomUUID()}`;
        GM_setValue(SHADOW_INSTALLATION_KEY, value);
      }
      return value;
    } catch (e) { return "install-unavailable"; }
  }

  function shadowPseudonymSalt() {
    try {
      let value = String(GM_getValue(SHADOW_PSEUDONYM_SALT_KEY, "") || "");
      if (!/^[a-f0-9]{64}$/.test(value)) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        value = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
        GM_setValue(SHADOW_PSEUDONYM_SALT_KEY, value);
      }
      return value;
    } catch (e) { return "shadow-pseudonym-fallback"; }
  }

  async function shadowHash(label, value) {
    const material = `${shadowPseudonymSalt()}:${label}:${String(value ?? "")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return [...new Uint8Array(digest)].slice(0, 12)
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function pseudonymizeShadowEvent(rawEvent) {
    const event = JSON.parse(JSON.stringify(rawEvent || {}));
    if (event.roomEpoch) event.roomEpoch = `room-${await shadowHash("room", event.roomEpoch)}`;
    if (event.message?.replyId) event.message.replyId = `msg-${await shadowHash("message", event.message.replyId)}`;
    if (event.sender?.memberNumber !== undefined) {
      event.sender.memberId = `member-${await shadowHash("member", event.sender.memberNumber)}`;
      delete event.sender.memberNumber;
      event.sender.name = event.sender.memberId;
    }
    for (const item of Array.isArray(event.context) ? event.context : []) {
      if (item.memberNumber !== undefined) {
        item.memberId = `member-${await shadowHash("member", item.memberNumber)}`;
        delete item.memberNumber;
        item.senderName = item.memberId;
      }
    }
    for (const member of Array.isArray(event.projection?.members) ? event.projection.members : []) {
      if (member.memberNumber !== undefined) {
        member.memberId = `member-${await shadowHash("member", member.memberNumber)}`;
        delete member.memberNumber;
        member.name = member.memberId;
      }
    }
    return event;
  }

  function shadowEndpoint(kind) {
    return kind === "legacy" ? SHADOW_LEGACY_ENDPOINT : SHADOW_EVENT_ENDPOINT;
  }

  async function flushShadowPending() {
    if (shadowUploadBusy || !shadowEnabled()) return;
    const secret = diagnosticSecret();
    if (secret.length < 24) return;
    shadowUploadBusy = true;
    try {
      const pending = readShadowPending();
      const remaining = [];
      for (const record of pending) {
        if (!await uploadSignedEnvelope(shadowEndpoint(record.kind), record.envelope, secret)) {
          remaining.push(record);
        }
      }
      writeShadowPending(remaining);
      if (pending.length > remaining.length) {
        console.log(`[MisakaShadow] 已上传 ${pending.length - remaining.length} 条影子记录`);
      }
    } finally {
      shadowUploadBusy = false;
    }
  }

  async function enqueueShadowDetail(kind, detail) {
    if (!shadowEnabled() || !detail) return;
    const payload = kind === "event"
      ? { event: await pseudonymizeShadowEvent(detail) }
      : { legacy: JSON.parse(JSON.stringify(detail)) };
    const envelope = {
      protocol: "misaka.shadow-upload.v1",
      kind,
      client: {
        version: SCRIPT_VERSION,
        installationId: shadowInstallationId(),
      },
      ...payload,
    };
    const pending = readShadowPending();
    pending.push({ kind, envelope });
    writeShadowPending(pending);
    void flushShadowPending();
  }

  pageWindow.__misakaShadowStatus = () => ({
    enabled: shadowEnabled(),
    configured: diagnosticSecret().length >= 24,
    pending: readShadowPending().length,
  });
  pageWindow.__misakaShadowSetEnabled = value => {
    const enabled = value === true;
    GM_setValue(SHADOW_ENABLED_KEY, enabled);
    if (enabled) void flushShadowPending();
    return pageWindow.__misakaShadowStatus();
  };

  function openDiagnosticSecretDialog() {
    if (!document.body || document.getElementById("misaka-diagnostics-secret-dialog")) return;
    const overlay = document.createElement("div");
    overlay.id = "misaka-diagnostics-secret-dialog";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", display: "grid",
      placeItems: "center", background: "rgba(0,0,0,.72)", color: "#eef",
    });
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(92vw, 420px)", padding: "20px", borderRadius: "12px",
      background: "#171b26", boxShadow: "0 12px 40px rgba(0,0,0,.5)",
      font: "16px/1.45 sans-serif",
    });
    const title = document.createElement("div");
    title.textContent = "御坂诊断上传密钥";
    title.style.fontWeight = "700";
    const note = document.createElement("div");
    note.textContent = "密钥只保存于 Tampermonkey 私有存储，用于签名故障包。";
    note.style.margin = "8px 0 12px";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = "至少 24 个字符";
    Object.assign(input.style, { width: "100%", boxSizing: "border-box", padding: "10px" });
    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "10px", marginTop: "14px" });
    const save = document.createElement("button");
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    save.onclick = () => {
      if (input.value.length < 24) { note.textContent = "密钥至少需要 24 个字符。"; return; }
      GM_setValue(DIAGNOSTIC_SECRET_KEY, input.value);
      input.value = "";
      overlay.remove();
      console.log("[MisakaChat] 诊断上传已启用");
      void flushDiagnosticPending();
    };
    cancel.onclick = () => { input.value = ""; overlay.remove(); };
    buttons.append(save, cancel);
    panel.append(title, note, input, buttons);
    overlay.append(panel);
    document.body.append(overlay);
    input.focus();
  }

  try {
    document.addEventListener(DIAGNOSTIC_UPLOAD_EVENT, event => enqueueDiagnosticEnvelope(event.detail));
    document.addEventListener(DIAGNOSTIC_CONFIG_EVENT, openDiagnosticSecretDialog);
    document.addEventListener(SHADOW_EVENT, event => void enqueueShadowDetail("event", event.detail));
    document.addEventListener(SHADOW_LEGACY_EVENT, event => void enqueueShadowDetail("legacy", event.detail));
    GM_registerMenuCommand("设置御坂诊断上传密钥", openDiagnosticSecretDialog);
    GM_registerMenuCommand("清除御坂诊断上传设置", () => {
      GM_deleteValue(DIAGNOSTIC_SECRET_KEY);
      GM_deleteValue(DIAGNOSTIC_PENDING_KEY);
      console.log("[MisakaChat] 诊断上传已停用");
    });
    GM_registerMenuCommand("开启御坂只读影子模式", () => {
      GM_setValue(SHADOW_ENABLED_KEY, true);
      console.log("[MisakaShadow] 只读影子模式已开启");
      void flushShadowPending();
    });
    GM_registerMenuCommand("关闭御坂只读影子模式", () => {
      GM_setValue(SHADOW_ENABLED_KEY, false);
      console.log("[MisakaShadow] 只读影子模式已关闭");
    });
    GM_registerMenuCommand("清除御坂影子本地数据", () => {
      GM_setValue(SHADOW_ENABLED_KEY, false);
      GM_deleteValue(SHADOW_PENDING_KEY);
      GM_deleteValue(SHADOW_INSTALLATION_KEY);
      GM_deleteValue(SHADOW_PSEUDONYM_SALT_KEY);
      console.log("[MisakaShadow] 本地影子队列与匿名化标识已清除");
    });
    Promise.resolve().then(() => void flushDiagnosticPending());
    Promise.resolve().then(() => void flushShadowPending());
  } catch (e) {}

  // 固定 revision，保证 loader、persona 与 runtime 始终来自同一版本。
  const ASSET_REVISION = "0f26d39";
  const BASE_URL = `https://raw.githack.com/Igallta/bc-gimp-sorter/${ASSET_REVISION}`;

  // BC 的“返回上个房间并恢复管理员房间”会在搜索阶段短暂没找到房间时
  // 调用 ChatRoomCreate，随后由 ChatRoomRecreate 以当前玩家身份发布一次完整
  // Room Update。御坂只是房间管理员，不应因为自动回房而重建/覆盖公共房间。
  // 仅在 ChatSearchAutoJoinRoom 本次调用期间临时关闭管理员恢复；找到现有房间
  // 后的正常加入不依赖该开关，账号持久设置也不会被修改。
  function installNativeRoomRecreateGuard(attempts) {
    attempts = attempts || 0;
    if (typeof ChatSearchAutoJoinRoom !== "function" ||
        typeof Player === "undefined" || !Player) {
      if (attempts < 600) setTimeout(() => installNativeRoomRecreateGuard(attempts + 1), 50);
      return;
    }
    if (Player.MemberNumber !== 194331 || window.__misakaNativeRoomRecreateGuard) return;
    const original = ChatSearchAutoJoinRoom;
    window.__misakaOrigChatSearchAutoJoinRoom = original;
    window.ChatSearchAutoJoinRoom = function() {
      const settings = Player?.ImmersionSettings;
      const restoreAdminRoom = settings?.ReturnToChatRoomAdmin;
      if (settings) settings.ReturnToChatRoomAdmin = false;
      try {
        return original.apply(this, arguments);
      } finally {
        if (settings) settings.ReturnToChatRoomAdmin = restoreAdminRoom;
      }
    };
    window.__misakaNativeRoomRecreateGuard = true;
    console.log("[MisakaChat] 已阻止自动回房重建管理员房间");
  }

  installNativeRoomRecreateGuard();

  function waitForReady(cb, attempts) {
    attempts = attempts || 0;
    if (typeof Player !== "undefined" && Player && Player.MemberNumber === 194331 &&
        typeof bcModSdk !== "undefined" &&
        typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" &&
        typeof ChatRoomMessage === "function" &&
        typeof ChatRoomSendChat === "function") {
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
