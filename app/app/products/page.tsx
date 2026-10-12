import Link from "next/link";
import { ArrowRight, Boxes, CirclePlus, Dna, ImageIcon } from "lucide-react";

import { readProducts } from "@/lib/products/product-queries";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

function statusLabel(status: string | null) {
  if (!status) return "Belum ada job";
  return status.replaceAll("_", " ");
}

export default async function ProductsPage() {
  const workspace = await resolveActiveWorkspace();
  const products = workspace ? await readProducts(workspace) : [];
  const canCreate = workspace?.role === "owner" || workspace?.role === "admin";

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-500">Products</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">Product workspace</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">Kelola produk, pantau status Product DNA, asset, dan job terkait dalam workspace aktif.</p>
          </div>
          {canCreate ? (
            <Link href="/app/products/new" className="inline-flex h-10 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800">
              <CirclePlus className="size-4" /> Produk baru
            </Link>
          ) : null}
        </div>

        {products.length === 0 ? (
          <section className="mt-8 rounded-2xl border border-dashed bg-white p-10 text-center">
            <Boxes className="mx-auto size-8 text-neutral-300" />
            <h2 className="mt-4 text-lg font-semibold">Belum ada produk</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-500">Tambahkan produk pertama untuk memulai Product DNA dan workflow UGC.</p>
            {canCreate ? <Link href="/app/products/new" className="mt-5 inline-flex h-10 items-center rounded-xl bg-neutral-950 px-4 text-sm font-semibold text-white">Buat produk</Link> : null}
          </section>
        ) : (
          <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <Link key={product.id} href={`/app/products/${product.id}`} className="group rounded-2xl border bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-neutral-200/50">
                <div className="flex items-start justify-between gap-4">
                  <div className="grid size-11 place-items-center rounded-xl bg-neutral-100"><Boxes className="size-5 text-neutral-600" /></div>
                  <ArrowRight className="size-4 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-neutral-700" />
                </div>
                <h2 className="mt-5 text-lg font-semibold">{product.name}</h2>
                <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-neutral-500">{product.description || "Belum ada deskripsi produk."}</p>
                <div className="mt-5 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl bg-neutral-50 p-3"><div className="flex items-center gap-1.5 text-neutral-400"><Dna className="size-3.5" /> Product DNA</div><p className="mt-1 font-semibold text-neutral-700">{product.dnaReady ? "Ready" : "Belum dibuat"}</p></div>
                  <div className="rounded-xl bg-neutral-50 p-3"><div className="flex items-center gap-1.5 text-neutral-400"><ImageIcon className="size-3.5" /> Assets</div><p className="mt-1 font-semibold text-neutral-700">{product.assetCount}</p></div>
                </div>
                <div className="mt-4 flex items-center justify-between border-t pt-4 text-xs text-neutral-400"><span className="capitalize">{statusLabel(product.latestJobStatus)}</span><span>{new Date(product.updatedAt).toLocaleDateString("id-ID")}</span></div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
