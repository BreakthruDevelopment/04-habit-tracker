/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "30 Apps Template";

export const APP_DESCRIPTION = "Part of the Breakthru Ventures 30 apps in 30 days portfolio.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `adminOnly` links are hidden for other users; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/admin", label: "Admin", adminOnly: true },
];
