/** Helpers shared by the provider implementations (Claude, Codex). */

/** Refresh OAuth tokens this long before they actually expire. */
export const REFRESH_MARGIN_MS = 60_000;

/** True when the token is expired or within the refresh margin of expiring. */
export function tokenNeedsRefresh(expiresAt: number, now: number): boolean {
  return now >= expiresAt - REFRESH_MARGIN_MS;
}
