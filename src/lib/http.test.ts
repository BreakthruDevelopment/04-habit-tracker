import { describe, expect, it } from "vitest";
import { errorInfo, readJson } from "@/lib/http";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/habits", { method: "POST", body, headers });

describe("readJson", () => {
  it("parses a JSON body", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });

  it("rejects a body over the cap with 413, by streaming count", async () => {
    const err = await readJson(post("x".repeat(2000)), 1000).catch((e) => e);
    expect(errorInfo(err).status).toBe(413);
  });

  it("rejects a lying small Content-Length on a big body, and an honest large one", async () => {
    const big = JSON.stringify({ body: "x".repeat(2000) });
    expect(errorInfo(await readJson(post(big, { "content-length": "10" }), 1000).catch((e) => e)).status).toBe(413);
    expect(errorInfo(await readJson(post("{}", { "content-length": "99999" }), 1000).catch((e) => e)).status).toBe(413);
  });

  it("accepts a body at exactly the cap", async () => {
    const body = JSON.stringify({ a: "x".repeat(100) });
    expect(await readJson(post(body), body.length)).toBeTruthy();
  });

  it("answers 400 for malformed JSON, an empty body, and invalid UTF-8", async () => {
    for (const bad of [post("{nope"), post(""), post(null), post(new Uint8Array([0xff, 0xfe, 0x7b]))]) {
      const info = errorInfo(await readJson(bad).catch((e) => e));
      expect(info.status).toBe(400);
      expect(info.body.error).toBe("Body must be valid JSON");
    }
  });
});
