import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { geminiProvider, geminiThinkingConfig } from "./providers";
import { AiError } from "./types";

beforeEach(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: "postgres://unused",
    BETTER_AUTH_SECRET: "x".repeat(32),
    LOG_LEVEL: "error",
    AI_TIMEOUT_MS: "20000",
  })) vi.stubEnv(k, v);
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

describe("geminiThinkingConfig", () => {
  it("asks 3-generation models and the -latest aliases for low thinking", () => {
    for (const m of ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview"]) {
      expect(geminiThinkingConfig(m)).toEqual({ thinkingLevel: "low" });
    }
  });
  it("sends nothing to 2.5 models, which use a different setting", () => {
    expect(geminiThinkingConfig("gemini-2.5-flash")).toBeUndefined();
    expect(geminiThinkingConfig("gemini-2.5-flash-lite")).toBeUndefined();
  });
});

describe("geminiProvider", () => {
  it("sends the thinking level in generationConfig", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"a":1}'));
    vi.stubGlobal("fetch", fetchMock);
    await geminiProvider("k", "gemini-flash-lite-latest").complete({ system: "s", prompt: "p", maxOutputTokens: 600 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 600, thinkingConfig: { thinkingLevel: "low" } });
  });

  it("retries a 503 once, then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(ok('{"a":1}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      geminiProvider("k", "gemini-flash-lite-latest").complete({ system: "s", prompt: "p", maxOutputTokens: 100 }),
    ).resolves.toBe('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the HTTP status (never the body) when the provider fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret details", { status: 400 })));
    const err = await geminiProvider("k", "gemini-flash-lite-latest")
      .complete({ system: "s", prompt: "p", maxOutputTokens: 100 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ kind: "provider", status: 400 });
    expect(String(err.message)).not.toContain("secret");
  });

  it("marks a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" })));
    const err = await geminiProvider("k", "gemini-flash-lite-latest")
      .complete({ system: "s", prompt: "p", maxOutputTokens: 100 })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "provider", status: "timeout" });
  });
});
