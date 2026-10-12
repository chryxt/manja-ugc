import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Boxes, Dna, FileImage, Sparkles } from "lucide-react";

import { readProductDetail } from "@/lib/products/product-queries";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

function prettyKey(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderDnaValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return "—";
}

export default async function ProductDetailPage({ params }: { params: Promise<{ productId: string }> }) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) notFound();
  const { productId } = await params;
  const product = await readProductDetail(workspace, productId);
  if (!product) notFound();

  const dnaEntries = product.dnaProfile ? Object.entries(product.dnaProfile) : [];

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <Link href="/app/products" className="inline-flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-950"><ArrowLeft className="size-4" /> Products</Link>

        <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4"><span className="grid size-12 place-items-center rounded-2xl bg-neutral-950 text-white"><Boxes className="size-5" /></span><div><p className="text-sm font-medium text-neutral-500">Product detail</p><h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">{product.name}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">{product.description || "Belum ada deskripsi produk."}</p></div></div>
          <div className="flex gap-2"><span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${product.dnaProfile ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}>{product.dnaProfile ? "DNA Ready" : "DNA Pending"}</span></div>
        </div>

        <section className="mt-8 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Product DNA</p><p className="mt-1 text-sm text-neutral-500">Profil AI tersimpan pada product record.</p></div><Dna className="size-5 text-neutral-400" /></div>
            {dnaEntries.length === 0 ? <div className="mt-6 rounded-xl border border-dashed bg-neutral-50 p-6 text-sm text-neutral-500">Product DNA belum tersedia. Product DNA generation akan diaktifkan pada F5.</div> : <dl className="mt-6 grid gap-3 sm:grid-cols-2">{dnaEntries.map(([key, value]) => <div key={key} className="rounded-xl bg-neutral-50 p-4"><dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{prettyKey(key)}</dt><dd className="mt-1 text-sm font-medium leading-5 text-neutral-700">{renderDnaValue(value)}</dd></div>)}</dl>}
          </article>

          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Source assets</p><p className="mt-1 text-sm text-neutral-500">{product.assets.length} asset terhubung.</p></div><FileImage className="size-5 text-neutral-400" /></div>
            {product.assets.length === 0 ? <div className="mt-6 rounded-xl border border-dashed bg-neutral-50 p-6 text-sm text-neutral-500">Belum ada asset. Upload close-up, packaging, dan logo masuk pada F4B.</div> : <div className="mt-5 space-y-2">{product.assets.map((asset) => <div key={asset.id} className="flex items-center justify-between rounded-xl bg-neutral-50 px-3 py-3"><div><p className="text-sm font-medium capitalize">{asset.assetType.replaceAll("_", " ")}</p><p className="mt-0.5 text-xs text-neutral-400">{asset.mimeType || "unknown"}</p></div>{asset.publicUrl ? <a href={asset.publicUrl} target="_blank" rel="noreferrer" className="text-neutral-400 hover:text-neutral-950"><ArrowUpRight className="size-4" /></a> : null}</div>)}</div>}
          </article>
        </section>

        <section className="mt-4 rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Related jobs</p><p className="mt-1 text-sm text-neutral-500">Riwayat job yang terikat ke product ini melalui domain binding.</p></div><Sparkles className="size-5 text-neutral-400" /></div>
          {product.jobs.length === 0 ? <p className="mt-6 rounded-xl bg-neutral-50 p-5 text-sm text-neutral-500">Belum ada job untuk produk ini.</p> : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b text-xs uppercase tracking-wider text-neutral-400"><tr><th className="pb-3 font-semibold">Job</th><th className="pb-3 font-semibold">Status</th><th className="pb-3 font-semibold">Progress</th><th className="pb-3 text-right font-semibold">Created</th></tr></thead><tbody>{product.jobs.map((job) => <tr key={job.id} className="border-b last:border-0"><td className="py-4"><p className="font-medium">{job.jobType.replaceAll("_", " ")}</p><p className="mt-0.5 font-mono text-xs text-neutral-400">{job.id.slice(0, 8)}</p></td><td className="py-4 capitalize text-neutral-600">{job.status.replaceAll("_", " ")}</td><td className="py-4 text-neutral-600">{job.progress}%</td><td className="py-4 text-right text-neutral-400">{new Date(job.createdAt).toLocaleString("id-ID")}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
    </main>
  );
}
