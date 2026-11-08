"use client";

import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./permissions";

// Same origin as the app, so no base URL is needed.
export const authClient = createAuthClient({
  plugins: [adminClient({ ac, roles })],
});

export const { signIn, signUp, signOut, useSession } = authClient;
