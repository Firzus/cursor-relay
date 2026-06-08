import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cacheTotals,
  DEFAULT_PERIOD,
  getPlanUsage,
  nextPeriod,
  pendingCount,
  type Period,
  type PlanUsageRecord,
  type PlanUsageSnapshot,
  periodSince,
  savePlanUsage,
  shouldPersistUsage,
  windowedCounters,
} from "./state.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("periodSince maps fixed windows to their epoch lower bound", () => {
  const now = 1_000_000_000_000;
  expect(periodSince("5h", now)).toBe(now - 5 * HOUR);
  expect(periodSince("24h", now)).toBe(now - DAY);
  expect(periodSince("7d", now)).toBe(now - 7 * DAY);
  expect(periodSince("30d", now)).toBe(now - 30 * DAY);
});

test("periodSince maps 'all' to 0 regardless of now", () => {
  expect(periodSince("all", 1_000_000_000_000)).toBe(0);
  expect(periodSince("all", 0)).toBe(0);
});

test("nextPeriod cycles 5h → 24h → 7d → 30d → all → 5h", () => {
  const order: Period[] = [];
  let p: Period = "5h";
  for (let i = 0; i < 5; i++) {
    order.push(p);
    p = nextPeriod(p);
  }
  expect(order).toEqual(["5h", "24h", "7d", "30d", "all"]);
  expect(nextPeriod("all")).toBe("5h"); // wraps
});

test("the default launch period is 24h", () => {
  expect(DEFAULT_PERIOD).toBe("24h");
});

/** Build a throwaway activity table with the columns cacheTotals reads. */
function seedDb(rows: Array<{ ts: number; cached: number | null; input: number | null }>): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      cached_tokens INTEGER,
      prompt_tokens INTEGER
    );
  `);
  const insert = db.query(
    "INSERT INTO activity (ts, cached_tokens, prompt_tokens) VALUES ($ts, $cached, $input)",
  );
  for (const r of rows) insert.run({ $ts: r.ts, $cached: r.cached, $input: r.input });
  return db;
}

test("cacheTotals sums only rows inside the window", () => {
  const now = 1_000_000_000_000;
  const db = seedDb([
    { ts: now - 2 * HOUR, cached: 80, input: 100 }, // inside
    { ts: now - 10 * HOUR, cached: 999, input: 999 }, // outside 5h
  ]);
  expect(cacheTotals(periodSince("5h", now), db)).toEqual({ cached: 80, input: 100 });
});

test("cold rows older than the window do not drag the rate toward 0%", () => {
  const now = 1_000_000_000_000;
  // One fresh warm row (90% cached) plus old cold first-turn rows (0% cached).
  const db = seedDb([
    { ts: now - HOUR, cached: 90, input: 100 },
    { ts: now - 2 * DAY, cached: 0, input: 100 },
    { ts: now - 3 * DAY, cached: 0, input: 100 },
  ]);
  const windowed = cacheTotals(periodSince("24h", now), db);
  expect(windowed).toEqual({ cached: 90, input: 100 }); // 90%, not buried
  const allTime = cacheTotals(periodSince("all", now), db);
  expect(allTime).toEqual({ cached: 90, input: 300 }); // 30% — the buried signal
});

test("cacheTotals treats NULL token counts as 0 and is empty on an empty window", () => {
  const now = 1_000_000_000_000;
  const db = seedDb([
    { ts: now - HOUR, cached: null, input: 100 },
    { ts: now - 2 * HOUR, cached: 50, input: null },
  ]);
  expect(cacheTotals(periodSince("24h", now), db)).toEqual({ cached: 50, input: 100 });
  // Window with no rows: COALESCE keeps the shape as zeros, not NULL.
  expect(cacheTotals(now + DAY, db)).toEqual({ cached: 0, input: 0 });
});

/** Build a throwaway activity table with the columns the counters reads need. */
function seedActivity(rows: Array<{ ts: number; status: string }>): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE activity (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const insert = db.query("INSERT INTO activity (ts, status) VALUES ($ts, $status)");
  for (const r of rows) insert.run({ $ts: r.ts, $status: r.status });
  return db;
}

test("windowedCounters counts requests and errors only inside the window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 2 * HOUR, status: "ok" }, // inside
    { ts: now - 3 * HOUR, status: "error" }, // inside
    { ts: now - 4 * HOUR, status: "pending" }, // inside
    { ts: now - 10 * HOUR, status: "error" }, // outside 5h
  ]);
  expect(windowedCounters(periodSince("5h", now), db)).toEqual({ requests: 3, errors: 1 });
  expect(windowedCounters(periodSince("all", now), db)).toEqual({ requests: 4, errors: 2 });
});

test("windowedCounters is zeros on an empty window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - 2 * HOUR, status: "ok" }]);
  expect(windowedCounters(now + DAY, db)).toEqual({ requests: 0, errors: 0 });
});

test("pendingCount counts in-flight rows regardless of the window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 1 * HOUR, status: "pending" },
    { ts: now - 20 * DAY, status: "pending" }, // old, but still in-flight (point-in-time)
    { ts: now - 1 * HOUR, status: "ok" },
    { ts: now - 1 * HOUR, status: "error" },
  ]);
  expect(pendingCount(db)).toBe(2);
});

test("pendingCount is 0 when nothing is in-flight", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - 1 * HOUR, status: "ok" }]);
  expect(pendingCount(db)).toBe(0);
});

// --- plan usage --------------------------------------------------------------

const SNAP: PlanUsageSnapshot = {
  fiveHour: { utilization: 0.71, resetAt: 1780926000000, status: "allowed" },
  weekly: { utilization: 0.19, resetAt: 1781409600000, status: "allowed" },
};

function rec(capturedAt: number, fiveStatus = "allowed", weekStatus = "allowed"): PlanUsageRecord {
  return {
    capturedAt,
    fiveHour: { ...SNAP.fiveHour, status: fiveStatus },
    weekly: { ...SNAP.weekly, status: weekStatus },
  };
}

test("shouldPersistUsage persists when there is no prior row", () => {
  expect(shouldPersistUsage(null, SNAP, 1000)).toBe(true);
});

test("shouldPersistUsage throttles repeated readings within the window", () => {
  const prev = rec(10_000);
  expect(shouldPersistUsage(prev, SNAP, 10_000 + 4_999)).toBe(false);
  expect(shouldPersistUsage(prev, SNAP, 10_000 + 5_000)).toBe(true); // at the boundary
});

test("shouldPersistUsage always persists on a status change, even within the window", () => {
  const prev = rec(10_000, "allowed", "allowed");
  const throttled = SNAP; // 1s later, normally throttled
  expect(shouldPersistUsage(prev, throttled, 11_000)).toBe(false);
  const fiveChanged = rec(10_000, "rejected", "allowed");
  expect(shouldPersistUsage(fiveChanged, SNAP, 11_000)).toBe(true);
  const weekChanged = rec(10_000, "allowed", "rejected");
  expect(shouldPersistUsage(weekChanged, SNAP, 11_000)).toBe(true);
});

/** In-memory plan_usage table mirroring db.ts. */
function planDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE plan_usage (
      provider           TEXT PRIMARY KEY,
      captured_at        INTEGER NOT NULL,
      fiveh_utilization  REAL NOT NULL,
      fiveh_reset        INTEGER NOT NULL,
      fiveh_status       TEXT NOT NULL,
      weekly_utilization REAL NOT NULL,
      weekly_reset       INTEGER NOT NULL,
      weekly_status      TEXT NOT NULL
    );
  `);
  return db;
}

test("savePlanUsage / getPlanUsage round-trip a snapshot", () => {
  const db = planDb();
  expect(getPlanUsage("claude", db)).toBeNull();
  savePlanUsage("claude", SNAP, 50_000, db);
  expect(getPlanUsage("claude", db)).toEqual({ capturedAt: 50_000, ...SNAP });
});

test("savePlanUsage upserts a single row per provider", () => {
  const db = planDb();
  savePlanUsage("claude", SNAP, 50_000, db);
  const next: PlanUsageSnapshot = {
    fiveHour: { utilization: 0.95, resetAt: 1780930000000, status: "rejected" },
    weekly: { utilization: 0.2, resetAt: 1781409600000, status: "allowed" },
  };
  savePlanUsage("claude", next, 60_000, db);
  expect(getPlanUsage("claude", db)).toEqual({ capturedAt: 60_000, ...next });
  const count = db.query("SELECT COUNT(*) AS n FROM plan_usage").get() as { n: number };
  expect(count.n).toBe(1);
});

test("getPlanUsage isolates rows per provider", () => {
  const db = planDb();
  savePlanUsage("claude", SNAP, 50_000, db);
  expect(getPlanUsage("codex", db)).toBeNull();
});
