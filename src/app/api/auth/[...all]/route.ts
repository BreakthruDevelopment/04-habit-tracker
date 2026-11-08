import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Built per request (cheap after the first) so the build never needs auth secrets.
export async function GET(request: Request) {
  return toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(auth()).POST(request);
}
