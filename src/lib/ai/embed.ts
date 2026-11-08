import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { geminiEmbed } from "./providers";
import { AiError, type EmbedRequest, type EmbedResult } from "./types";

export const EMBED_DIMS = 768;
export const EMBED_MAX_TEXTS = 32;
export const EMBED_MAX_CHARS = 8_000;
export const EMBED_MAX_TOTAL_CHARS = 64_000;
export const DEMO_EMBED_MODEL = "demo-hash-768";
export const DEFAULT_EMBED_MODEL = "gemini-embedding-2";

let warnedMissingKey = false;

/** The model embed() uses for live vectors, so callers can compare it with stored `embedding_model`. */
export function liveEmbedModel(): string {
  return env().AI_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

/** Scale to unit length. A zero vector is returned unchanged. */
export function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? v.slice() : v.map((x) => x / norm);
}

function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(token)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-words: lexical, offline, no network. */
export function demoVector(text: string): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const t of tokens) v[fnv1a(t) % EMBED_DIMS] += 1;
  return l2Normalize(v);
}

function geminiKey(): string | null {
  const e = env();
  if (e.AI_PROVIDER === "demo") return null;
  if (e.GEMINI_API_KEY) return e.GEMINI_API_KEY;
  if (!warnedMissingKey) {
    log.warn("ai.provider.missing_key", { provider: "gemini", variable: "GEMINI_API_KEY", fallback: "demo" });
    warnedMissingKey = true;
  }
  return null;
}

/**
 * Embeddings through the same gateway rules as generate(): input caps, timeout, demo fallback and
 * a structured log line (task, provider, model, count, latency; never the text). Anthropic has no
 * embeddings API, so `AI_PROVIDER=anthropic` embeds with Gemini when a key exists, else demo.
 */
export async function embed(req: EmbedRequest): Promise<EmbedResult> {
  const { texts } = req;
  if (texts.length > EMBED_MAX_TEXTS) {
    throw new AiError(`At most ${EMBED_MAX_TEXTS} texts per call`, "input_rejected");
  }
  let total = 0;
  for (const t of texts) {
    if (t.length > EMBED_MAX_CHARS) {
      throw new AiError(`Each text must be at most ${EMBED_MAX_CHARS} characters`, "input_rejected");
    }
    if (t.trim() === "") throw new AiError("Texts must not be empty", "input_rejected");
    total += t.length;
  }
  if (total > EMBED_MAX_TOTAL_CHARS) {
    throw new AiError(`Texts total more than ${EMBED_MAX_TOTAL_CHARS} characters`, "input_rejected");
  }

  const started = Date.now();
  const finish = (vectors: number[][], provider: string, model: string, demo: boolean): EmbedResult => {
    const latencyMs = Date.now() - started;
    log.info("ai.embed", { task: req.task, provider, model, demo, count: texts.length, latencyMs });
    return { vectors, provider, model, dims: EMBED_DIMS, demo, latencyMs };
  };
  const demoResult = () => finish(texts.map(demoVector), "demo", DEMO_EMBED_MODEL, true);

  if (texts.length === 0) return demoResult();
  const key = geminiKey();
  if (!key) return demoResult();

  const model = liveEmbedModel();
  try {
    const raw = await geminiEmbed(key, model, texts, req.kind, EMBED_DIMS);
    if (raw.length !== texts.length || raw.some((v) => v.length !== EMBED_DIMS || !v.every(Number.isFinite))) {
      throw new AiError("Embedding response had the wrong count or dimensions", "invalid_output");
    }
    return finish(raw.map(l2Normalize), "gemini", model, false);
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : "provider";
    log.warn("ai.embed.failed", { task: req.task, provider: "gemini", kind, status: err instanceof AiError ? err.status : undefined });
    if (env().AI_FALLBACK_TO_DEMO) return demoResult();
    throw err instanceof AiError ? err : new AiError("Embedding request failed", "provider");
  }
}
