import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileEvidenceStore } from "./evidenceStore.js";

describe("local evidence store", () => {
  it("stores exact private bytes once and reads their metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pophq-evidence-"));
    const store = fileEvidenceStore(directory);
    const content = new TextEncoder().encode("evidence");
    const record = { recordId: "shot-1", sha256: "f00", size: content.byteLength, contentType: "text/plain" };
    expect(await store.head(record.recordId)).toBeUndefined();
    await store.put(record, content);
    expect(await store.head(record.recordId)).toEqual(record);
    expect(await store.get(record.recordId)).toEqual({ ...record, content: Buffer.from(content) });
    await expect(store.put(record, content)).rejects.toThrow(/already exists/);
  });
});
