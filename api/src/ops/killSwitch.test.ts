import { describe, expect, it, vi } from "vitest";
import { trip } from "./killSwitch.js";

describe("trip", () => {
  it("turns the flag on", async () => {
    const write = vi.fn(async () => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await trip(write, { Records: [] });
    expect(write).toHaveBeenCalledWith("on");
  });

  it("fails loudly if the write fails, so SNS retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(trip(async () => Promise.reject(new Error("denied")), {})).rejects.toThrow("denied");
  });
});
