import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/domain/errors.js";
import { linkLogin } from "../../src/ops/linkLogin.js";
import { createHarness, type Harness } from "./harness.js";

const actor = { id: "owner-bootstrap", via: "admin" as const };
const logins: Record<string, string> = { "site.owner@example.com": "sub-owner", "second@example.com": "sub-second" };
const findSub = async (email: string) => logins[email];

describe("linkLogin (owner bootstrap)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.cleanup());

  it("creates the game account and links the login", async () => {
    const res = await linkLogin(
      { repo: h.repo, findSub, actor },
      { email: "Site.Owner@example.com ", playerId: "123456789", name: "FrostLord", rank: "R4" },
    );
    expect(res).toMatchObject({ sub: "sub-owner", accountCreated: true, linked: true });
    expect(await h.repo.getAccount("123456789")).toMatchObject({ name: "FrostLord", alliance: "POP", rank: "R4" });

    const me = await h.call("GET", "/me", { as: "sub-owner", groups: ["owner"] });
    expect(me.status).toBe(200);
    expect(me.body.accounts).toEqual([expect.objectContaining({ playerId: "123456789" })]);
  });

  it("is safe to run again", async () => {
    const res = await linkLogin(
      { repo: h.repo, findSub, actor },
      { email: "site.owner@example.com", playerId: "123456789", name: "Renamed" },
    );
    expect(res).toMatchObject({ accountCreated: false, linked: false });
    expect((await h.repo.getAccount("123456789"))?.name).toBe("FrostLord");
  });

  it("refuses to link an account that belongs to another login", async () => {
    await expect(
      linkLogin({ repo: h.repo, findSub, actor }, { email: "second@example.com", playerId: "123456789", name: "FrostLord" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects unknown logins and invalid input before writing anything", async () => {
    await expect(
      linkLogin({ repo: h.repo, findSub, actor }, { email: "nobody@example.com", playerId: "987654321", name: "Ghost" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      linkLogin({ repo: h.repo, findSub, actor }, { email: "second@example.com", playerId: "12", name: "Bad" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await h.repo.getAccount("987654321")).toBeUndefined();
  });
});
