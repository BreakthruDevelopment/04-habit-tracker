import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { log } from "@/lib/log";

/** Map known errors to clean JSON responses; never leak stack traces or internals. */
export function errorResponse(err: unknown): Response {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return Response.json(
      { error: "Invalid input", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) },
      { status: 400 },
    );
  }
  if (err instanceof AiError) {
    const status = err.kind === "input_rejected" ? 400 : err.kind === "quota" ? 429 : 502;
    return Response.json({ error: err.message }, { status });
  }
  log.error("request.failed", { error: err instanceof Error ? err.message : String(err) });
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}
