import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { deleteItem } from "@/lib/items";

export const dynamic = "force-dynamic";

/** DELETE /api/items/:id — owners delete their own items; admins delete any. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const deleted = await deleteItem(user, id);
    return deleted
      ? new Response(null, { status: 204 })
      : Response.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err);
  }
}
