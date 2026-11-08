import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { DEMO_EMBED_MODEL, EMBED_DIMS, embed } from "./index";

const baseEnv = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "x".repeat(32),
  LOG_LEVEL: "error",
};

function setEnv(extra: Record<string, string>) {
  for (const k of ["AI_PROVIDER", "AI_FALLBACK_TO_DEMO", "AI_EMBED_MODEL", "GEMINI_API_KEY", "AI_TIMEOUT_MS"]) {
    vi.stubEnv(k, "");
  }
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const vec = (n: number, x = 0.1) => Array.from({ length: n }, () => x);
const ok = (embeddings: number[][]) =>
  new Response(JSON.stringify({ embeddings: embeddings.map((values) => ({ values })) }));

beforeEach(() => setEnv({ AI_PROVIDER: "demo" }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("embed (demo)", () => {
  it("is deterministic, 768-dim and unit length", async () => {
    const a = await embed({ task: "t", texts: ["PTO carry over days"], kind: "document" });
    const b = await embed({ task: "t", texts: ["PTO carry over days"], kind: "query" });
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(a.vectors[0]).toHaveLength(EMBED_DIMS);
    expect(a.dims).toBe(768);
    expect(norm(a.vectors[0])).toBeCloseTo(1, 6);
    expect(a).toMatchObject({ demo: true, provider: "demo", model: DEMO_EMBED_MODEL });
  });

  it("ranks lexically similar text closer", async () => {
    const { vectors } = await embed({
      task: "t",
      texts: ["how many pto days carry over", "PTO days: 5 carry over each year", "deploy runbook for staging"],
      kind: "document",
    });
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(vectors[0], vectors[1])).toBeGreaterThan(dot(vectors[0], vectors[2]));
  });

  it("enforces the caps", async () => {
    const reject = { kind: "input_rejected" };
    await expect(embed({ task: "t", texts: Array(33).fill("a"), kind: "document" })).rejects.toMatchObject(reject);
    await expect(embed({ task: "t", texts: ["x".repeat(8001)], kind: "document" })).rejects.toMatchObject(reject);
    await expect(embed({ task: "t", texts: Array(9).fill("x".repeat(7500)), kind: "document" })).rejects.toMatchObject(
      reject,
    );
  });

  it("falls back to demo with a single call when the key is missing", async () => {
    setEnv({ AI_PROVIDER: "gemini" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await embed({ task: "t", texts: ["a"], kind: "query" });
    expect(r.demo).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anthropic without a Gemini key uses demo", async () => {
    setEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    expect((await embed({ task: "t", texts: ["a"], kind: "query" })).demo).toBe(true);
  });
});

describe("embed (gemini)", () => {
  it("sends batchEmbedContents with taskType and 768 dims for gemini-embedding-001, and normalizes", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_EMBED_MODEL: "gemini-embedding-001" });
    const fetchMock = vi.fn().mockResolvedValue(ok([vec(768, 2), vec(768, 3)]));
    vi.stubGlobal("fetch", fetchMock);
    const r = await embed({ task: "t", texts: ["a", "b"], kind: "document" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("gemini-embedding-001:batchEmbedContents");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({
      model: "models/gemini-embedding-001",
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 768,
    });
    expect(r).toMatchObject({ demo: false, provider: "gemini", model: "gemini-embedding-001", dims: 768 });
    expect(norm(r.vectors[1])).toBeCloseTo(1, 6);
  });

  it("uses RETRIEVAL_QUERY for queries on gemini-embedding-001", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_EMBED_MODEL: "gemini-embedding-001" });
    const fetchMock = vi.fn().mockResolvedValue(ok([vec(768)]));
    vi.stubGlobal("fetch", fetchMock);
    await embed({ task: "t", texts: ["q"], kind: "query" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).requests[0].taskType).toBe("RETRIEVAL_QUERY");
  });

  it("defaults to gemini-embedding-2 with the documented text prefixes and no taskType", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    const fetchMock = vi.fn().mockResolvedValue(ok([vec(768)]));
    vi.stubGlobal("fetch", fetchMock);
    const r = await embed({ task: "t", texts: ["hello"], kind: "query" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("gemini-embedding-2:batchEmbedContents");
    const req = JSON.parse(init.body).requests[0];
    expect(req.taskType).toBeUndefined();
    expect(req).toMatchObject({ model: "models/gemini-embedding-2", outputDimensionality: 768 });
    expect(req.content.parts[0].text).toBe("task: search result | query: hello");
    expect(r.model).toBe("gemini-embedding-2");

    fetchMock.mockResolvedValue(ok([vec(768)]));
    await embed({ task: "t", texts: ["hello"], kind: "document" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).requests[0].content.parts[0].text).toBe("title: none | text: hello");
  });

  it("rejects empty or whitespace-only texts", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    await expect(embed({ task: "t", texts: ["ok", "  "], kind: "document" })).rejects.toMatchObject({ kind: "input_rejected" });
  });

  it("on 429 falls back to demo vectors labelled as demo", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    const r = await embed({ task: "t", texts: ["a"], kind: "document" });
    expect(r).toMatchObject({ demo: true, model: DEMO_EMBED_MODEL });
  });

  it("on 429 throws a quota error when fallback is off", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    await expect(embed({ task: "t", texts: ["a"], kind: "document" })).rejects.toMatchObject({ kind: "quota" });
  });

  it("rejects a wrong-length response as invalid_output", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([vec(512)])));
    await expect(embed({ task: "t", texts: ["a"], kind: "document" })).rejects.toMatchObject({
      kind: "invalid_output",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([vec(768)])));
    await expect(embed({ task: "t", texts: ["a", "b"], kind: "document" })).rejects.toMatchObject({
      kind: "invalid_output",
    });
  });

  it("anthropic provider embeds with Gemini when a key exists", async () => {
    setEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([vec(768)])));
    expect((await embed({ task: "t", texts: ["a"], kind: "query" })).provider).toBe("gemini");
  });
});
