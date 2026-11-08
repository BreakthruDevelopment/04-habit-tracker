"use client";

import "./globals.css";

/** Last-resort boundary for errors in the root layout itself. Generic on purpose: never shows error details. */
export default function GlobalError({ retry }: { error: Error; retry: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="max-w-md space-y-4">
          <h1 className="text-3xl font-semibold">Something went wrong.</h1>
          <p className="text-muted">Try again. If it keeps happening, come back in a few minutes.</p>
          <button
            type="button"
            onClick={() => retry()}
            className="inline-flex min-h-11 items-center rounded-card bg-accent px-4 text-sm font-semibold text-accent-foreground"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
