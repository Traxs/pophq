import { describe, expect, it } from "vitest";
import { viewerRequestCode, type ViewerRequestOptions } from "../lib/viewer-request.js";

interface QueryValue {
  value: string;
  multiValue?: { value: string }[];
}

interface Request {
  uri: string;
  headers: Record<string, { value: string }>;
  querystring: Record<string, QueryValue>;
}

/** Runs the generated source the way CloudFront does: a global `handler(event)`. */
function run(options: ViewerRequestOptions, host: string, uri: string, querystring: Record<string, QueryValue> = {}) {
  const handler = new Function(`${viewerRequestCode(options)}\nreturn handler;`)() as (event: {
    request: Request;
  }) => unknown;
  return handler({ request: { uri, headers: { host: { value: host } }, querystring } });
}

const SITE = { canonicalHost: "pophq.example", spa: true };

describe("viewer-request function", () => {
  it("sends www to the domain permanently, keeping path and query", () => {
    const response = run(SITE, "www.pophq.example", "/events/abc", {
      tab: { value: "answers" },
      id: { value: "1", multiValue: [{ value: "1" }, { value: "2" }] },
      debug: { value: "" },
    }) as { statusCode: number; headers: { location: { value: string } } };

    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe("https://pophq.example/events/abc?tab=answers&id=1&id=2&debug");
  });

  it("redirects the bare www root to the domain root", () => {
    const response = run(SITE, "www.pophq.example", "/") as { headers: { location: { value: string } } };
    expect(response.headers.location.value).toBe("https://pophq.example/");
  });

  it("serves index.html for client-side routes on the domain and on the CloudFront name", () => {
    expect(run(SITE, "pophq.example", "/members")).toMatchObject({ uri: "/index.html" });
    // The old origin keeps working without a redirect: sessions there live in its own storage.
    expect(run(SITE, "d111111abcdef8.cloudfront.net", "/callback")).toMatchObject({ uri: "/index.html" });
  });

  it("leaves files alone", () => {
    expect(run(SITE, "pophq.example", "/assets/app-1234.js")).toMatchObject({ uri: "/assets/app-1234.js" });
  });

  it("never rewrites API paths in the API variant", () => {
    const api = { canonicalHost: "pophq.example", spa: false };
    expect(run(api, "pophq.example", "/v1/health")).toMatchObject({ uri: "/v1/health" });
    expect(run(api, "www.pophq.example", "/v1/health")).toMatchObject({ statusCode: 301 });
  });

  it("only rewrites when no domain is configured", () => {
    expect(run({ spa: true }, "www.pophq.example", "/members")).toMatchObject({ uri: "/index.html" });
  });
});
