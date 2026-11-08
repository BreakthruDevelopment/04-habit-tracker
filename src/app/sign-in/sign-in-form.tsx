"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { signIn, signUp } from "@/lib/auth/client";

export function SignInForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "");
    const result =
      mode === "sign-in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email.split("@")[0] });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That didn't work. Check your details and try again.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {mode === "sign-up" && (
        <label className={labelClass}>
          <span>Name</span>
          <input name="name" autoComplete="name" className={inputClass} />
        </label>
      )}
      <label className={labelClass}>
        <span>Email</span>
        <input name="email" type="email" required autoComplete="email" className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className={`${buttonPrimary} w-full`}
      >
        {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
        className="min-h-11 w-full text-sm font-medium text-accent underline underline-offset-2"
      >
        {mode === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
