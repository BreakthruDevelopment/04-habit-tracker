import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Newsreader, Public_Sans } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import { APP_DESCRIPTION, APP_TITLE } from "@/lib/app-config";
import "./globals.css";

const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap" });
const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-public-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: APP_TITLE, template: `%s · ${APP_TITLE}` },
  description: APP_DESCRIPTION,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${publicSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
