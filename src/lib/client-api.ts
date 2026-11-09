/** Helpers for client components that call this app's own routes with same-origin fetch. */

export type ApiFailure = {
  status: number;
  message: string;
  /** Field name to message, taken from the zod issues a 400 carries. */
  fields: Record<string, string>;
};

const GENERIC = "Something went wrong. Try again.";

/** Read the `{ error, issues? }` body every route sends on failure; never throws. */
export async function readFailure(res: Response): Promise<ApiFailure> {
  let body: { error?: unknown; issues?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON (a proxy page, an empty body): fall back to the generic message.
  }
  const fields: Record<string, string> = {};
  if (Array.isArray(body.issues)) {
    for (const issue of body.issues as { path?: unknown[]; message?: unknown }[]) {
      const key = issue.path?.[0];
      if (typeof key === "string" && typeof issue.message === "string" && !(key in fields)) fields[key] = issue.message;
    }
  }
  const message = typeof body.error === "string" && body.error ? body.error : GENERIC;
  return { status: res.status, message: Object.keys(fields).length > 0 ? "Check the highlighted fields." : message, fields };
}

/** JSON request to a same-origin route. Network errors become a failure with status 0. */
export async function sendJson(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ ok: true; status: number; data: unknown } | ({ ok: false } & ApiFailure)> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) return { ok: false, ...(await readFailure(res)) };
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (err) {
    const aborted = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      ok: false,
      status: aborted ? -1 : 0,
      message: aborted ? "That took too long." : "Couldn't reach the server. Check your connection and try again.",
      fields: {},
    };
  }
}
