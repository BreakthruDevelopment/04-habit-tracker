import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetEnvCache } from "@/lib/env";
import { AiError, MAX_PROMPT_CHARS, extractJson, generate } from "./index";

const schema = z.object({ summary: z.string(), highlights: z.array(z.string()) });

const baseEnv = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "x".repeat(32),
  LOG_LEVEL: "error",
};

function setEnv(extra: Record<string, string>) {
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "");
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}

beforeEach(() => setEnv({ AI_PROVIDER: "demo" }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("rejects prose", () => {
    expect(() => extractJson("Sure! Here you go.")).toThrow(AiError);
  });
});

describe("generate", () => {
  it("serves the recorded answer in demo mode", async () => {
    const result = await generate({ task: "summarize-items", system: "s", prompt: "p", schema });
    expect(result.demo).toBe(true);
    expect(result.data.highlights.length).toBeGreaterThan(0);
  });

  it("rejects oversized input before calling any model", async () => {
    await expect(
      generate({ task: "summarize-items", system: "s", prompt: "x".repeat(MAX_PROMPT_CHARS + 1), schema }),
    ).rejects.toMatchObject({ kind: "input_rejected" });
  });

  it("uses the live provider and validates its output", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"summary":"live","highlights":["a"]}' }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generate({ task: "summarize-items", system: "s", prompt: "p", schema });
    expect(result).toMatchObject({ demo: false, provider: "gemini", data: { summary: "live" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    // The key travels in a header, never in the URL where it would be logged.
    expect(String(url)).not.toContain("test-key");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "test-key" });
  });

  it("falls back to demo when the provider hits its quota", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    const result = await generate({ task: "summarize-items", system: "s", prompt: "p", schema });
    expect(result.demo).toBe(true);
  });

  it("surfaces the error when fallback is off", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    await expect(
      generate({ task: "summarize-items", system: "s", prompt: "p", schema }),
    ).rejects.toMatchObject({ kind: "quota" });
  });

  it("rejects model output that fails the schema", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"wrong":true}' }] } }] }), {
          status: 200,
        }),
      ),
    );
    await expect(
      generate({ task: "summarize-items", system: "s", prompt: "p", schema }),
    ).rejects.toMatchObject({ kind: "invalid_output" });
  });
});

describe("missing provider key", () => {
  it("answers from the demo fixture instead of failing", async () => {
    setEnv({ AI_PROVIDER: "gemini" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await generate({ task: "summarize-items", system: "s", prompt: "p", schema });
    expect(result.demo).toBe(true);
    expect(result.provider).toBe("demo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
