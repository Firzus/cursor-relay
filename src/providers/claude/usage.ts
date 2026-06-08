/**
 * Parse Anthropic's unified rate-limit response headers into a plan-usage
 * snapshot. Header shapes verified live in issue #11 (max plan, OAuth path):
 *   anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}
 *   - utilization: 0–1 fraction (e.g. 0.71 = 71%)
 *   - reset:       epoch seconds (10 digits, e.g. 1780926000)
 *   - status:      string enum (e.g. "allowed")
 * The 7d (general) window is "weekly"; the model-scoped 7d_sonnet variant is
 * deliberately ignored — ADR-0002 tracks the plan-wide weekly window.
 */
import type { PlanUsageSnapshot, PlanWindow } from "../../store/state.ts";

const PREFIX = "anthropic-ratelimit-unified";

/** Minimal shape we need from a Headers object (real `Headers` satisfies it). */
export interface HeaderBag {
  get(name: string): string | null;
}

/**
 * Normalize utilization to a 0–1 fraction. Anthropic sends a fraction, but be
 * defensive: a value above 1 must be a 0–100 percent, so fold it back.
 */
function normalizeUtilization(raw: number): number {
  return raw > 1 ? raw / 100 : raw;
}

/**
 * Normalize a reset epoch to milliseconds. Anthropic sends seconds (10 digits);
 * anything already large enough to be ms (≥ 1e12) is passed through unchanged.
 */
function normalizeResetToMs(raw: number): number {
  return raw < 1e12 ? raw * 1000 : raw;
}

function readWindow(headers: HeaderBag, key: "5h" | "7d"): PlanWindow | null {
  const util = headers.get(`${PREFIX}-${key}-utilization`);
  const reset = headers.get(`${PREFIX}-${key}-reset`);
  const status = headers.get(`${PREFIX}-${key}-status`);
  if (util == null || reset == null || status == null) return null;
  const u = Number(util);
  const r = Number(reset);
  if (!Number.isFinite(u) || !Number.isFinite(r)) return null;
  return { utilization: normalizeUtilization(u), resetAt: normalizeResetToMs(r), status };
}

/**
 * Build a 5h + weekly snapshot from response headers, or null when either
 * window's headers are absent or unparseable (e.g. a non-OAuth path).
 */
export function parseAnthropicRateLimitHeaders(headers: HeaderBag): PlanUsageSnapshot | null {
  const fiveHour = readWindow(headers, "5h");
  const weekly = readWindow(headers, "7d");
  if (!fiveHour || !weekly) return null;
  return { fiveHour, weekly };
}
