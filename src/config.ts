export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PORT = parsePositiveIntEnv("PORT", 8787);
export const DEBUG_LOG = process.env.DEBUG_LOG === "1" || process.env.DEBUG_LOG === "true";

export const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
export const TUNNEL_HOSTNAME = process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? "";

/** The single sentinel model id exposed to Cursor. */
export const SENTINEL_MODEL = "shim";
