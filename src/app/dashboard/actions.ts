"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { requireUser } from "@/lib/auth/session";
import { createItem, deleteItem, summarizeItems } from "@/lib/items";

export type ActionState = { error?: string; ok?: boolean };

// Server actions are public endpoints: each one re-reads the session itself.

export async function addItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    await createItem(user, { title: form.get("title"), body: form.get("body") ?? "" });
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Invalid input" };
    throw err;
  }
}

export async function deleteItemAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await deleteItem(user, String(form.get("id") ?? ""));
  revalidatePath("/dashboard");
}

export type SummaryState = {
  summary?: string;
  highlights?: string[];
  demo?: boolean;
  error?: string;
};

export async function summarizeAction(): Promise<SummaryState> {
  try {
    const user = await requireUser();
    const { data, demo } = await summarizeItems(user);
    return { ...data, demo };
  } catch (err) {
    if (err instanceof AiError) return { error: "The AI summary isn't available right now." };
    throw err;
  }
}
