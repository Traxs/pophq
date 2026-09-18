import { describe, expect, it, vi } from "vitest";
import { createPauseCheck } from "./pause.js";

describe("createPauseCheck", () => {
  it("is paused only when the flag reads 'on'", async () => {
    for (const [value, expected] of [["on", true], [" ON ", true], ["off", false], ["", false], [undefined, false]] as const) {
      expect(await createPauseCheck(async () => value)()).toBe(expected);
    }
  });

  it("reuses a read within the TTL and refreshes after it", async () => {
    let t = 0;
    const read = vi.fn(async () => "off");
    const check = createPauseCheck(read, { ttlMs: 60_000, now: () => t });
    await check();
    t = 59_999;
    await check();
    expect(read).toHaveBeenCalledTimes(1);
    t = 60_000;
    await check();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent requests", async () => {
    const read = vi.fn(async () => "on");
    const check = createPauseCheck(read);
    expect(await Promise.all([check(), check(), check()])).toEqual([true, true, true]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known state when a read fails", async () => {
    let t = 0;
    const errors: unknown[] = [];
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce("on").mockRejectedValueOnce(new Error("throttled"));
    const check = createPauseCheck(read, { now: () => t, onError: (e) => errors.push(e) });
    expect(await check()).toBe(true);
    t = 120_000;
    expect(await check()).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("is not paused if the very first read fails", async () => {
    const check = createPauseCheck(async () => Promise.reject(new Error("no access")), { onError: () => {} });
    expect(await check()).toBe(false);
  });
});
