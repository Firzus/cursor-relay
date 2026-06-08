import {
  BoxRenderable,
  bold,
  createCliRenderer,
  cyan,
  dim,
  green,
  type KeyEvent,
  red,
  StyledText,
  stringToStyledText,
  type TextChunk,
  TextRenderable,
  yellow,
} from "@opentui/core";
import { PORT, TUNNEL_HOSTNAME } from "../config.ts";
import { allProviders, getProvider } from "../providers/registry.ts";
import {
  cacheTotals,
  DEFAULT_PERIOD,
  getPlanUsage,
  getSelection,
  nextPeriod,
  type Period,
  periodSince,
  type PlanWindow,
  recentActivity,
  setSelection,
} from "../store/state.ts";
import type { AuthStatus, Effort, ProviderId, Selection } from "../providers/types.ts";

/** Abbreviate a count with k/M suffixes above 1000 (e.g. 1234 → "1.2k"). */
export function abbreviateCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * The per-request token segment for an activity row: `pt→ct` plus a
 * `(cached X)` witness when cache reads landed on that request — the
 * per-request proof the breakpoints work, independent of the aggregate rate.
 * Empty when no token counts were recorded (e.g. a pending row); the cached
 * segment is omitted when there are no cache reads, to avoid `cached 0` noise.
 * Pure (no color) — prior art: formatCacheRate.
 */
export function formatActivityTokens(row: {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
}): string {
  if (row.prompt_tokens == null && row.completion_tokens == null) return "";
  const pt = row.prompt_tokens ?? "?";
  const ct = row.completion_tokens ?? "?";
  const cached =
    row.cached_tokens != null && row.cached_tokens > 0
      ? ` (cached ${abbreviateCount(row.cached_tokens)})`
      : "";
  return ` ${pt}→${ct}tok${cached}`;
}

export type UsageLevel = "ok" | "warn" | "crit";

/**
 * Threshold band for a utilization fraction, mapped to colour by the caller.
 * `warn` at 70%, `crit` at 90% — comfortable headroom before the plan is spent.
 */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 0.9) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

/** Human countdown from `now` to `resetAt` (both epoch ms). Pure. */
export function formatResetCountdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

const BAR_WIDTH = 10;

/**
 * Render one plan-usage bar (without colour): `5h     [████░░░░░░]  71%  resets in 1h 2m`.
 * Utilization is a 0–1 fraction; the caller colours by `usageLevel`. A status
 * other than "allowed" (e.g. "rejected") is appended so a throttled window is
 * visible, not just implied by the colour. Pure.
 */
export function formatPlanUsage(label: string, window: PlanWindow, now: number): string {
  const frac = Math.max(0, Math.min(1, window.utilization));
  const filled = Math.round(frac * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const pct = Math.round(frac * 100);
  const flag = window.status && window.status !== "allowed" ? `  ${window.status}` : "";
  return `${label.padEnd(7)}[${bar}] ${String(pct).padStart(3)}%  resets in ${formatResetCountdown(window.resetAt, now)}${flag}`;
}

/**
 * Render the cache-rate line body (without color) for the active period.
 * Returns the dim dash form when there is no usable input data in the window.
 */
export function formatCacheRate(totals: { cached: number; input: number }, period: Period): string {
  if (totals.input <= 0) return `cache rate (${period})  —`;
  const pct = Math.round((totals.cached / totals.input) * 100);
  return `cache rate (${period})  ${pct}%  (${abbreviateCount(totals.cached)} cached / ${abbreviateCount(totals.input)} input)`;
}

// --- status bar presenters (pure) --------------------------------------------

/** Semantic state of a provider auth dot, mapped to colour by the caller. */
export type AuthDotState = "ok" | "down" | "pending";

/**
 * Map an auth status (or its absence, before the first check) to a dot state.
 * `pending` is the dim "not checked yet" state; `down` carries an error the
 * caller surfaces inline. Pure.
 */
export function authDotState(auth: AuthStatus | undefined): AuthDotState {
  if (!auth) return "pending";
  return auth.ok ? "ok" : "down";
}

/** Endpoint URL + tunnel state for the meta strip. `up` when a tunnel hostname is configured. */
export interface EndpointInfo {
  url: string;
  tunnel: "up" | "off";
}

/**
 * Where Cursor should point, plus whether a tunnel fronts it. The TUI only
 * knows the configured hostname (it does not run the tunnel), so `up` means
 * "a public hostname is configured", `off` means local-only. Pure.
 */
export function formatEndpoint(tunnelHostname: string, port: number): EndpointInfo {
  if (tunnelHostname) return { url: `https://${tunnelHostname}/v1`, tunnel: "up" };
  return { url: `http://127.0.0.1:${port}/v1`, tunnel: "off" };
}

/**
 * Truncate an inline detail (e.g. a down provider's auth error) to `max`
 * characters, appending an ellipsis when cut, so a long message cannot blow out
 * the meta strip. Pure.
 */
export function truncateDetail(detail: string, max = 48): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max - 1)}…`;
}

/**
 * The inline label for one provider in the meta strip: just the id when the
 * provider is ok or unchecked, or `id detail` (truncated) when it is down — so
 * an auth failure is diagnosable without leaving the panel. Pure.
 */
export function formatAuthMeta(id: string, auth: AuthStatus | undefined): string {
  if (auth && !auth.ok && auth.detail) return `${id} ${truncateDetail(auth.detail)}`;
  return id;
}

// --- OpenTUI mount -----------------------------------------------------------
//
// The mount layer below is intentionally thin and untested: it builds the
// chrome (three zones) once and pushes fresh StyledText into the Text
// renderables on each cadence. All formatting decisions live in the pure
// presenters above; the native core owns differential rendering (no flicker)
// and the Yoga flexbox layout (the chrome structure).

/** Single cyan accent for the chrome (border + title). Semantic status colors stay green/red/yellow. */
const ACCENT = "#22d3ee";

/** Cadences, decoupled so auth checks do not piggyback the fast data poll. */
const DATA_POLL_MS = 400;
const AUTH_REFRESH_MS = 5000;

/** A single space as a default-styled chunk, for inline gaps between styled segments. */
const SPACE: TextChunk = stringToStyledText(" ").chunks[0]!;

/** Join per-line StyledText fragments into one multi-line StyledText for a Text renderable. */
function joinLines(lines: StyledText[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, i) => {
    if (i > 0) chunks.push(...stringToStyledText("\n").chunks);
    chunks.push(...line.chunks);
  });
  return new StyledText(chunks);
}

/** One activity row as a single styled line (color applied here, formatting in the presenters). */
function activityLine(row: ReturnType<typeof recentActivity>[number]): StyledText {
  const time = new Date(row.ts).toLocaleTimeString();
  const status =
    row.status === "ok" ? green(row.status) : row.status === "error" ? red(row.status) : yellow(row.status);
  return new StyledText([
    dim(time),
    SPACE,
    status,
    dim(` ${row.provider}/${row.model}`),
    dim(formatActivityTokens(row)),
    dim(row.duration_ms != null ? ` ${row.duration_ms}ms` : ""),
  ]);
}

/**
 * Live control panel. Reads selection + activity from the shared store and
 * writes the selection back when you cycle it — that store is the control
 * channel to the background service.
 *
 *   p cycle provider · m cycle model · e cycle effort · w window · q quit
 */
export async function runTui(): Promise<void> {
  const providers = allProviders();
  const providerIds = providers.map((p) => p.id);
  let sel = getSelection();
  let period: Period = DEFAULT_PERIOD;
  const authCache = new Map<ProviderId, AuthStatus>();

  const refreshAuth = async (): Promise<void> => {
    for (const p of providers) {
      try {
        authCache.set(p.id, await p.authStatus());
      } catch (err) {
        authCache.set(p.id, { ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

  // --- chrome: three zones, built once -------------------------------------
  const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const statusBar = new BoxRenderable(renderer, {
    id: "status",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const selText = new TextRenderable(renderer, { id: "sel", content: "" });
  const metaText = new TextRenderable(renderer, { id: "meta", content: "" });
  statusBar.add(selText);
  statusBar.add(metaText);

  const stream = new BoxRenderable(renderer, {
    id: "stream",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    title: " activity ",
    titleColor: ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const streamText = new TextRenderable(renderer, { id: "streamText", content: "" });
  stream.add(streamText);

  const metrics = new BoxRenderable(renderer, {
    id: "metrics",
    border: true,
    borderStyle: "single",
    borderColor: ACCENT,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const metricsText = new TextRenderable(renderer, { id: "metricsText", content: "" });
  const hintsText = new TextRenderable(renderer, { id: "hints", content: "" });
  metrics.add(metricsText);
  metrics.add(hintsText);

  app.add(statusBar);
  app.add(stream);
  app.add(metrics);
  renderer.root.add(app);

  // --- render: data → props ------------------------------------------------
  const render = (): void => {
    const now = Date.now();

    // tier 1: active selection, highlighted as the control anchor (bold accent
    // values, dim labels) so the operator always knows which backend serves traffic.
    selText.content = new StyledText([
      bold(cyan("shim")),
      dim("  provider "),
      bold(cyan(sel.provider)),
      dim("  model "),
      bold(cyan(sel.model)),
      dim("  effort "),
      bold(cyan(sel.effort)),
    ]);

    // tier 2: dim meta strip — endpoint, tunnel state, and per-provider auth
    // dots; a down provider surfaces its error detail inline.
    const endpoint = formatEndpoint(TUNNEL_HOSTNAME, PORT);
    const metaChunks: TextChunk[] = [
      dim(`${endpoint.url}  `),
      endpoint.tunnel === "up" ? green("tunnel up") : yellow("no tunnel"),
    ];
    for (const p of providers) {
      const a = authCache.get(p.id);
      const state = authDotState(a);
      const dot = state === "ok" ? green("●") : state === "down" ? red("●") : dim("●");
      metaChunks.push(SPACE, SPACE, dot, dim(` ${formatAuthMeta(p.id, a)}`));
    }
    metaText.content = new StyledText(metaChunks);

    // center: activity stream (newest first)
    const rows = recentActivity(10);
    streamText.content = rows.length
      ? joinLines(rows.map(activityLine))
      : new StyledText([dim("(no activity yet)")]);

    // bottom: cache rate + plan usage
    const lines: StyledText[] = [
      new StyledText([dim(formatCacheRate(cacheTotals(periodSince(period, now)), period))]),
    ];
    const usage = getPlanUsage("claude");
    if (!usage) {
      lines.push(new StyledText([dim("plan usage (claude)  (no data yet)")]));
    } else {
      const bar = (label: string, w: PlanWindow): StyledText => {
        const lvl = usageLevel(w.utilization);
        const color = lvl === "crit" ? red : lvl === "warn" ? yellow : green;
        return new StyledText([color(formatPlanUsage(label, w, now))]);
      };
      lines.push(bar("5h", usage.fiveHour), bar("weekly", usage.weekly));
    }
    metricsText.content = joinLines(lines);

    hintsText.content = new StyledText([dim("p provider · m model · e effort · w window · q quit")]);

    renderer.requestRender();
  };

  const commit = (next: Selection): void => {
    sel = next;
    setSelection(sel);
    render();
  };

  const cycleProvider = (): void => {
    const i = providerIds.indexOf(sel.provider);
    const nextId = providerIds[(i + 1) % providerIds.length] as ProviderId;
    const first = getProvider(nextId).models()[0];
    if (!first) return;
    const effort: Effort = first.efforts.includes(sel.effort) ? sel.effort : (first.efforts[0] ?? "medium");
    commit({ provider: nextId, model: first.id, effort });
  };

  const cycleModel = (): void => {
    const models = getProvider(sel.provider).models();
    const i = models.findIndex((m) => m.id === sel.model);
    const next = models[(i + 1) % models.length];
    if (!next) return;
    const effort: Effort = next.efforts.includes(sel.effort) ? sel.effort : (next.efforts[0] ?? "medium");
    commit({ ...sel, model: next.id, effort });
  };

  const cycleEffort = (): void => {
    const model = getProvider(sel.provider).models().find((m) => m.id === sel.model);
    const efforts = model?.efforts ?? [];
    if (!efforts.length) return;
    const i = efforts.indexOf(sel.effort);
    commit({ ...sel, effort: efforts[(i + 1) % efforts.length] as Effort });
  };

  const cyclePeriod = (): void => {
    period = nextPeriod(period);
    render();
  };

  let dataTimer: ReturnType<typeof setInterval> | undefined;
  let authTimer: ReturnType<typeof setInterval> | undefined;

  const quit = (): void => {
    if (dataTimer) clearInterval(dataTimer);
    if (authTimer) clearInterval(authTimer);
    renderer.destroy();
    process.exit(0);
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return quit();
    switch (key.name) {
      case "p":
        return cycleProvider();
      case "m":
        return cycleModel();
      case "e":
        return cycleEffort();
      case "w":
        return cyclePeriod();
      case "q":
        return quit();
    }
  });

  await refreshAuth();
  render();
  // Data poll re-reads the store and updates props; auth refresh runs on a
  // slower, decoupled cadence so authStatus() is not invoked several times a second.
  dataTimer = setInterval(() => {
    sel = getSelection();
    render();
  }, DATA_POLL_MS);
  authTimer = setInterval(() => {
    void refreshAuth();
  }, AUTH_REFRESH_MS);
}
