export function requireCdpBase() {
  const configured = String(process.env.MISAKA_CDP_URL || "").trim();
  if (!configured) {
    throw new Error(
      "MISAKA_CDP_URL is required for raw-CDP runners. " +
      "Ubuntu browser automation normally uses OpenClaw profile=user; " +
      "set this variable only when a compatible CDP HTTP endpoint is intentionally available.",
    );
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("MISAKA_CDP_URL must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("MISAKA_CDP_URL must use http or https");
  }
  return configured.replace(/\/+$/, "");
}
