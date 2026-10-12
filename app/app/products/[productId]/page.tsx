import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, Dna, FileImage, ShieldCheck, Sparkles, UploadCloud } from "lucide-react";

import { uploadProductAsset } from "@/app/app/products/actions";
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

function formatBytes(value: number | null) {
  if (value === null) return "unknown size";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const errorMessages: Record<string, string> = {
  forbidden: "Role kamu tidak diizinkan mengunggah asset.",
  "invalid-asset-type": "Klasifikasi asset tidak valid.",
  "file-required": "Pilih file gambar terlebih dahulu.",
  "file-too-large": "File terlalu besar. Maksimal 4 MB pada checkpoint F4B.",
  "unsupported-file-type": "Format belum didukung. Gunakan JPG, PNG, atau WebP.",
  "r2-unavailable": "R2 belum dikonfigurasi pada deployment ini atau koneksi storage sedang gagal.",
  "asset-persist-failed": "File sudah dikirim ke storage tetapi metadata gagal disimpan dan upload telah dibersihkan.",
};

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ error?: string; uploaded?: string }>;
}) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) notFound();
  const { productId } = await params;
  const query = await searchParams;
  const product = await readProductDetail(workspace, productId);
  if (!product) notFound();

  const dnaEntries = product.dnaProfile ? Object.entries(product.dnaProfile) : [];
  const canMutate = workspace.role === "owner" || workspace.role === "admin";
  const uploadAction = uploadProductAsset.bind(null, product.id);

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <Link href="/app/products" className="inline-flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-950"><ArrowLeft className="size-4" /> Products</Link>

        <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4"><span className="grid size-12 place-items-center rounded-2xl bg-neutral-950 text-white"><Boxes className="size-5" /></span><div><p className="text-sm font-medium text-neutral-500">Product detail</p><h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">{product.name}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">{product.description || "Belum ada deskripsi produk."}</p></div></div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${product.dnaProfile ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}>{product.dnaProfile ? "DNA Ready" : "DNA Pending"}</span>
        </div>

        {query.uploaded ? <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">Asset berhasil diunggah ke R2 dan metadata sudah tersimpan.</div> : null}
        {query.error ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{errorMessages[query.error] ?? "Upload asset gagal."}</div> : null}

        <section className="mt-8 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Product DNA</p><p className="mt-1 text-sm text-neutral-500">Profil AI tersimpan pada product record.</p></div><Dna className="size-5 text-neutral-400" /></div>
            {dnaEntries.length === 0 ? <div className="mt-6 rounded-xl border border-dashed bg-neutral-50 p-6 text-sm text-neutral-500">Product DNA belum tersedia. Product DNA generation akan diaktifkan pada F5.</div> : <dl className="mt-6 grid gap-3 sm:grid-cols-2">{dnaEntries.map(([key, value]) => <div key={key} className="rounded-xl bg-neutral-50 p-4"><dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{prettyKey(key)}</dt><dd className="mt-1 text-sm font-medium leading-5 text-neutral-700">{renderDnaValue(value)}</dd></div>)}</dl>}
          </article>

          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Upload source asset</p><p className="mt-1 text-sm text-neutral-500">Original image dipertahankan untuk Product Accuracy Lock.</p></div><UploadCloud className="size-5 text-neutral-400" /></div>
            {canMutate ? <form action={uploadAction} className="mt-5 space-y-4">
              <label className="block"><span className="text-xs font-semibold text-neutral-600">Classification</span><select name="assetType" required className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="product_closeup">Product close-up</option><option value="packaging">Packaging</option><option value="logo_watermark">Logo / watermark</option><option value="reference">Other reference</option></select></label>
              <label className="block"><span className="text-xs font-semibold text-neutral-600">Image file</span><input name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="mt-2 block w-full rounded-xl border bg-neutral-50 p-3 text-sm" /></label>
              <div className="flex items-start gap-2 rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-500"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><span>JPG/PNG/WebP, maksimum 4 MB. File asli disimpan di R2; checksum SHA-256 disimpan di database untuk fidelity tracking.</span></div>
              <button type="submit" className="h-11 w-full rounded-xl bg-neutral-950 px-4 text-sm font-semibold text-white hover:bg-neutral-800">Upload asset</button>
            </form> : <div className="mt-5 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-500">Role member memiliki akses baca saja. Upload hanya tersedia untuk owner/admin.</div>}
          </article>
        </section>

        <section className="mt-4 rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Source assets</p><p className="mt-1 text-sm text-neutral-500">{product.assets.length} original asset terhubung ke produk.</p></div><FileImage className="size-5 text-neutral-400" /></div>
          {product.assets.length === 0 ? <div className="mt-6 rounded-xl border border-dashed bg-neutral-50 p-6 text-sm text-neutral-500">Belum ada source asset. Upload close-up, packaging, logo, atau reference image di atas.</div> : <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{product.assets.map((asset) => <article key={asset.id} className="overflow-hidden rounded-xl border bg-neutral-50">{asset.previewUrl ? <img src={asset.previewUrl} alt={asset.originalFilename || asset.assetType} className="aspect-square w-full object-cover" /> : <div className="grid aspect-square place-items-center bg-neutral-100 text-xs text-neutral-400">Preview unavailable</div>}<div className="p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold capitalize">{asset.assetType.replaceAll("_", " ")}</p><ShieldCheck className="size-4 text-emerald-600" /></div><p className="mt-1 truncate text-xs text-neutral-500">{asset.originalFilename || "unnamed"}</p><p className="mt-1 text-xs text-neutral-400">{asset.mimeType || "unknown"} · {formatBytes(asset.sizeBytes)}</p>{asset.checksumSha256 ? <p className="mt-2 truncate font-mono text-[10px] text-neutral-400" title={asset.checksumSha256}>sha256:{asset.checksumSha256.slice(0, 16)}…</p> : null}</div></article>)}</div>}
        </section>

        <section className="mt-4 rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Related jobs</p><p className="mt-1 text-sm text-neutral-500">Riwayat job yang terikat ke product ini melalui domain binding.</p></div><Sparkles className="size-5 text-neutral-400" /></div>
          {product.jobs.length === 0 ? <p className="mt-6 rounded-xl bg-neutral-50 p-5 text-sm text-neutral-500">Belum ada job untuk produk ini.</p> : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b text-xs uppercase tracking-wider text-neutral-400"><tr><th className="pb-3 font-semibold">Job</th><th className="pb-3 font-semibold">Status</th><th className="pb-3 font-semibold">Progress</th><th className="pb-3 text-right font-semibold">Created</th></tr></thead><tbody>{product.jobs.map((job) => <tr key={job.id} className="border-b last:border-0"><td className="py-4"><p className="font-medium">{job.jobType.replaceAll("_", " ")}</p><p className="mt-0.5 font-mono text-xs text-neutral-400">{job.id.slice(0, 8)}</p></td><td className="py-4 capitalize text-neutral-600">{job.status.replaceAll("_", " ")}</td><td className="py-4 text-neutral-600">{job.progress}%</td><td className="py-4 text-right text-neutral-400">{new Date(job.createdAt).toLocaleString("id-ID")}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
    </main>
  );
}
