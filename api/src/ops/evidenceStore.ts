import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvidenceObject {
  recordId: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface EvidenceContent extends EvidenceObject {
  content: Uint8Array;
}

export interface EvidenceStore {
  head(recordId: string): Promise<EvidenceObject | undefined>;
  get(recordId: string): Promise<EvidenceContent>;
  put(record: EvidenceObject, content: Uint8Array): Promise<void>;
}

const key = (recordId: string) => `evidence/${recordId}`;

export function s3EvidenceStore(client: S3Client, bucket: string): EvidenceStore {
  return {
    async head(recordId) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key(recordId) }));
        return {
          recordId,
          sha256: result.Metadata?.sha256 ?? "",
          size: result.ContentLength ?? 0,
          contentType: result.ContentType ?? "application/octet-stream",
        };
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    async get(recordId) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(recordId) }));
        if (!result.Body) throw new NotFoundError("Evidence content not found.");
        const content = await result.Body.transformToByteArray();
        return {
          recordId,
          sha256: result.Metadata?.sha256 ?? "",
          size: content.byteLength,
          contentType: result.ContentType ?? "application/octet-stream",
          content,
        };
      } catch (err) {
        if (isMissing(err)) throw new NotFoundError("Evidence content not found.");
        throw err;
      }
    },
    async put(record, content) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key(record.recordId),
          Body: content,
          ContentType: record.contentType,
          Metadata: { sha256: record.sha256 },
          IfNoneMatch: "*",
        }));
      } catch (err) {
        if (isPrecondition(err)) throw new ConflictError(`Evidence content ${record.recordId} already exists.`);
        throw err;
      }
    },
  };
}

/** Local debugging equivalent: private files under an ignored workspace directory. */
export function fileEvidenceStore(directory: string): EvidenceStore {
  const paths = (recordId: string) => ({ content: join(directory, recordId), meta: join(directory, `${recordId}.json`) });
  const readMeta = async (recordId: string): Promise<EvidenceObject | undefined> => {
    try {
      return JSON.parse(await readFile(paths(recordId).meta, "utf8")) as EvidenceObject;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined;
      throw err;
    }
  };
  return {
    head: readMeta,
    async get(recordId) {
      const meta = await readMeta(recordId);
      if (!meta) throw new NotFoundError("Evidence content not found.");
      const content = await readFile(paths(recordId).content);
      return { ...meta, content };
    },
    async put(record, content) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(paths(record.recordId).content, content, { flag: "wx", mode: 0o600 });
        await writeFile(paths(record.recordId).meta, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          throw new ConflictError(`Evidence content ${record.recordId} already exists.`);
        }
        throw err;
      }
      const saved = await stat(paths(record.recordId).content);
      if (saved.size !== record.size) throw new Error("Local evidence write was incomplete.");
    },
  };
}

function isMissing(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && ("name" in err && (err.name === "NotFound" || err.name === "NoSuchKey")));
}

function isPrecondition(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "name" in err && err.name === "PreconditionFailed");
}
