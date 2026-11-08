import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { NAV_LINKS, APP_TITLE, PARENT_SITE } from "@/lib/app-config";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { log } from "@/lib/log";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import { buttonOutlineAccent } from "./ui/styles";

async function currentUserOrNull(): Promise<CurrentUser | null> {
  try {
    return await getCurrentUser();
  } catch (err) {
    // A database blip must not take the public pages down with it.
    log.warn("app_shell_user_lookup_failed", { error: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}

/**
 * The Breakthru header and footer around every page. Header: logo, divider, app name,
 * navigation, then sign-in or the user's name with sign out. Footer: one link, no logo.
 * `nav` replaces the default links from app-config when an app needs its own.
 */
export async function AppShell({ children, nav }: { children: ReactNode; nav?: ReactNode }) {
  // Opt into per-request rendering before the try/catch below, so the catch never swallows the framework's dynamic signal.
  await connection();
  const user = await currentUserOrNull();
  const links = NAV_LINKS.filter((l) => !l.adminOnly || user?.role === "admin");

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-20 focus:rounded-card focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Link href="/" className="flex min-h-11 min-w-0 basis-full items-center gap-3 sm:basis-auto" aria-label={`${APP_TITLE} home`}>
            {/* Full-colour logo in light mode; the white-on-transparent mono logo in dark mode. */}
            <Image
              src="/branding/breakthru-logo.png"
              alt="Breakthru Ventures"
              width={115}
              height={32}
              unoptimized
              preload
              className="h-8 w-auto shrink-0 dark:hidden"
            />
            <Image
              src="/branding/breakthru-logo-dark.png"
              alt="Breakthru Ventures"
              width={115}
              height={32}
              unoptimized
              className="hidden h-8 w-auto shrink-0 dark:block"
            />
            <span aria-hidden className="h-8 w-px shrink-0 bg-border" />
            <span className="truncate font-sans text-lg font-semibold tracking-tight sm:text-xl">{APP_TITLE}</span>
          </Link>

          <div className="flex flex-1 items-center sm:ml-auto sm:flex-none">
            {nav ?? <NavLinks links={links} />}
          </div>

          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="hidden max-w-40 truncate text-sm text-muted md:inline" title={user.email}>
                  {user.name}
                </span>
                <SignOutButton />
              </>
            ) : (
              <Link href="/sign-in" className={buttonOutlineAccent}>
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex w-full max-w-6xl justify-end px-4 sm:px-6">
          <a
            href={PARENT_SITE.href}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent hover:underline"
          >
            {PARENT_SITE.label} <span aria-hidden>↗</span>
          </a>
        </div>
      </footer>
    </>
  );
}
