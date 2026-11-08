import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { BadRequestError, HttpError, PayloadTooLargeError } from "@/lib/errors";
import { log } from "@/lib/log";

export type ErrorInfo = { status: number; body: { error: string; issues?: unknown } };

/** Map known errors to a status and a client-safe body; never leak stack traces or internals. */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    };
  }
  if (err instanceof AiError) {
    const status = err.kind === "input_rejected" ? 400 : err.kind === "quota" ? 429 : 502;
    return { status, body: { error: err.message } };
  }
  log.error("request.failed", { error: err instanceof Error ? err.message : String(err) });
  return { status: 500, body: { error: "Something went wrong" } };
}

export function errorResponse(err: unknown): Response {
  const { status, body } = errorInfo(err);
  return Response.json(body, { status });
}

/** Largest JSON body any route accepts (every payload here is a small form or an upload request). */
export const JSON_BODY_LIMIT = 16 * 1024;

/**
 * Read the request body exactly once, as bytes, refusing anything over `limit` bytes.
 * Checks Content-Length first, then counts while streaming so a lying header can't get past.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parse a UTF-8 JSON body; 400 when it isn't valid JSON. */
export function parseJsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestError("Body must be valid JSON");
  }
}

/** Capped read plus JSON parse: 413 when too large, 400 when not JSON. */
export async function readJson(request: Request, limit: number = JSON_BODY_LIMIT): Promise<unknown> {
  return parseJsonBody(await readBodyCapped(request, limit));
}
