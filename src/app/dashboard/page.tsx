import type { Metadata } from "next";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile, buttonDanger } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listItems } from "@/lib/items";
import { deleteItemAction } from "./actions";
import { AddItemForm, SummaryPanel } from "./client";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Item = Awaited<ReturnType<typeof listItems>>[number];

const sorts = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A to Z" },
];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const user = await requireUserOrRedirect();
  const all = await listItems(user);

  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const sort = sorts.some((s) => s.value === one(sp.sort)) ? one(sp.sort) : "newest";
  const view = one(sp.view) === "cards" ? "cards" : "table";

  const items = all
    .filter((i) => !q || `${i.title} ${i.body}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "oldest"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
    );

  const columns: Column<Item>[] = [
    { key: "title", header: "Item", primary: true, cell: (i) => <span className="font-semibold break-words">{i.title}</span> },
    { key: "body", header: "Details", cell: (i) => <span className="text-muted break-words">{i.body || "—"}</span> },
    {
      key: "created",
      header: "Added",
      className: "whitespace-nowrap",
      cell: (i) => i.createdAt.toISOString().slice(0, 10),
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      hideLabel: true,
      className: "text-right",
      cell: (i) => (
        <form action={deleteItemAction}>
          <input type="hidden" name="id" value={i.id} />
          <button type="submit" className={buttonDanger} aria-label={`Delete ${i.title}`}>
            Delete
          </button>
        </form>
      ),
    },
  ];

  return (
    <>
      <PageIntro
        section="Dashboard"
        title={`Hi, ${user.name}`}
        description={`Signed in as ${user.email}. Role: ${user.role}.`}
      />

      <StatGrid>
        <StatTile value={all.length} label={user.role === "admin" ? "Items (everyone's)" : "Your items"} tone="accent" />
        <StatTile value={items.length} label="Shown" />
      </StatGrid>

      <Panel title="AI summary">
        <SummaryPanel />
      </Panel>

      <Panel title="Add an item">
        <AddItemForm />
      </Panel>

      <Panel title={user.role === "admin" ? "All items" : "Your items"} count={all.length}>
        <FilterBar
          label="Filter items"
          search={{ value: q, placeholder: "Search items…" }}
          sort={{ name: "sort", label: "Sort", value: sort, options: sorts }}
          view={{ value: view }}
        />
        <DataList
          caption="Items"
          rows={items}
          rowKey={(i) => i.id}
          columns={columns}
          view={view}
          empty={all.length === 0 ? "Nothing yet. Add your first item above." : "No items match your search."}
        />
      </Panel>
    </>
  );
}
