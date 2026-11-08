import { env } from "@/lib/env";
import { type AiProvider, AiError } from "./types";

async function postOnce(url: string, headers: Record<string, string>, body: unknown, deadline: number) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AiError("Model provider timed out", "provider", "timeout");
    }
    throw new AiError("Model provider unreachable", "provider");
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const deadline = Date.now() + env().AI_TIMEOUT_MS;
  let res = await postOnce(url, headers, body, deadline);
  // Free-tier models are often briefly overloaded: retry a 500/503 once if there's time left.
  if ((res.status === 500 || res.status === 503) && deadline - Date.now() > 3000) {
    await new Promise((r) => setTimeout(r, 400));
    res = await postOnce(url, headers, body, deadline);
  }
  if (res.status === 429) throw new AiError("Model quota reached", "quota", 429);
  if (!res.ok) {
    // Never echo the response body: it can contain request details.
    throw new AiError(`Model provider returned HTTP ${res.status}`, "provider", res.status);
  }
  return res.json();
}

/**
 * Gemini 3-generation models (and the -latest aliases) think before answering, and thinking tokens
 * count against maxOutputTokens and add seconds. "low" is accepted by every Flash model and alias
 * ("minimal" is rejected by gemini-flash-latest). 2.5 models use a different setting, so they get none.
 */
export function geminiThinkingConfig(model: string): { thinkingLevel: "low" } | undefined {
  return /^gemini-(3|flash|flash-lite|pro)(-|\.|$)/.test(model) ? { thinkingLevel: "low" } : undefined;
}

/** Google Gemini API (free tier via Google AI Studio). */
export function geminiProvider(apiKey: string, model: string): AiProvider {
  return {
    name: "gemini",
    model,
    async complete({ system, prompt, maxOutputTokens, images }) {
      const json = (await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [
            {
              role: "user",
              parts: [...(images ?? []).map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: prompt }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens,
            ...(geminiThinkingConfig(model) ? { thinkingConfig: geminiThinkingConfig(model) } : {}),
          },
        },
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
      if (!text) throw new AiError("Empty response from model", "invalid_output");
      return text;
    },
  };
}

/** Anthropic Claude (Messages API). Optional: for clients who pay for it. */
export function anthropicProvider(apiKey: string, model: string): AiProvider {
  return {
    name: "anthropic",
    model,
    async complete({ system, prompt, maxOutputTokens, images }) {
      // HEIC/HEIF are not supported by the Messages API; refuse before any network call.
      if (images?.some((i) => i.mimeType === "image/heic" || i.mimeType === "image/heif")) {
        throw new AiError("Anthropic does not accept HEIC/HEIF images", "input_rejected");
      }
      const json = (await post(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: maxOutputTokens,
          system: `${system}\n\nRespond with JSON only, no prose and no code fences.`,
          messages: [
            {
              role: "user",
              content: images?.length
                ? [
                    ...images.map((i) => ({
                      type: "image",
                      source: { type: "base64", media_type: i.mimeType, data: i.data },
                    })),
                    { type: "text", text: prompt },
                  ]
                : prompt,
            },
          ],
        },
      )) as { content?: { type: string; text?: string }[] };
      const text = json.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (!text) throw new AiError("Empty response from model", "invalid_output");
      return text;
    },
  };
}

/**
 * Gemini batchEmbedContents. `gemini-embedding-2` takes the task as an instruction inside the text;
 * older models (`gemini-embedding-001`) take a `taskType` field. Vectors are returned as sent by the API;
 * the caller validates and normalizes them.
 */
export async function geminiEmbed(
  apiKey: string,
  model: string,
  texts: string[],
  kind: "document" | "query",
  dims: number,
): Promise<number[][]> {
  const instructed = model.startsWith("gemini-embedding-2");
  const requests = texts.map((text) => ({
    model: `models/${model}`,
    content: {
      parts: [{ text: instructed ? embedInstruction(kind, text) : text }],
    },
    ...(instructed ? {} : { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }),
    outputDimensionality: dims,
  }));
  const json = (await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
    { "x-goog-api-key": apiKey },
    { requests },
  )) as { embeddings?: { values?: number[] }[] };
  return (json.embeddings ?? []).map((e) => e.values ?? []);
}

function embedInstruction(kind: "document" | "query", text: string): string {
  return kind === "query"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}
