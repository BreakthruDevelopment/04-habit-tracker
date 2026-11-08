"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  if (links.length === 0) return null;
  return (
    <nav aria-label="Main" className="flex items-center gap-5">
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center border-b-2 text-sm font-semibold ${
              active ? "border-accent text-accent" : "border-transparent text-foreground hover:text-accent"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
