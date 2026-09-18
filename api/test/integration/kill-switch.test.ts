import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("kill switch", () => {
  let h: Harness;
  let paused = false;

  beforeAll(async () => {
    h = await createHarness({ isPaused: async () => paused });
  });
  afterAll(() => h.cleanup());

  it("serves normally while the switch is off", async () => {
    paused = false;
    expect((await h.call("GET", "/health")).status).toBe(200);
    expect((await h.call("GET", "/me", { as: "player" })).status).toBe(200);
  });

  it("answers 503 on every route, before auth, while the switch is on", async () => {
    paused = true;
    for (const [method, path, as] of [
      ["GET", "/health", undefined],
      ["GET", "/me", "player"],
      ["GET", "/me", undefined],
      ["POST", "/accounts", "officer"],
      ["GET", "/does-not-exist", undefined],
    ] as const) {
      const res = await h.call(method, path, as ? { as } : {});
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.body.type).toBe("about:blank#paused");
    }
  });
});
