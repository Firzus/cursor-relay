import { test, expect } from "bun:test";
import { abbreviateCount, formatCacheRate } from "./tui.ts";

test("abbreviateCount leaves values <= 1000 unabbreviated", () => {
  expect(abbreviateCount(0)).toBe("0");
  expect(abbreviateCount(999)).toBe("999");
  expect(abbreviateCount(1000)).toBe("1k");
});

test("abbreviateCount uses k notation above 1000", () => {
  expect(abbreviateCount(1200)).toBe("1.2k");
  expect(abbreviateCount(2700)).toBe("2.7k");
  expect(abbreviateCount(12_000)).toBe("12k");
});

test("abbreviateCount uses M notation above one million", () => {
  expect(abbreviateCount(1_000_000)).toBe("1M");
  expect(abbreviateCount(2_500_000)).toBe("2.5M");
});

test("formatCacheRate renders an integer percentage with abbreviated counts", () => {
  expect(formatCacheRate({ cached: 1200, input: 2700 })).toBe(
    "cache rate  44%  (1.2k cached / 2.7k input)",
  );
});

test("formatCacheRate rounds the percentage to an integer", () => {
  expect(formatCacheRate({ cached: 1, input: 3 })).toBe("cache rate  33%  (1 cached / 3 input)");
});

test("formatCacheRate shows a dim dash when there is no usable input", () => {
  expect(formatCacheRate({ cached: 0, input: 0 })).toBe("cache rate  —");
});

test("formatCacheRate treats negative input as the empty state", () => {
  expect(formatCacheRate({ cached: 0, input: -5 })).toBe("cache rate  —");
});
