import Link from "next/link";
import { Clapperboard, Dna, Film, ShieldCheck, Sparkles } from "lucide-react";

import { generateStoryboardAction } from "@/app/app/generate/actions";
import { readDnaReadyProducts, readRecentStoryboards } from "@/lib/storyboards/storyboard-queries";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const errorMessages: Record<string, string> = {
  forbidden: "Role kamu tidak diizinkan membuat storyboard.",
  "product-required": "Pilih produk DNA Ready terlebih dahulu.",
  "product-not-found": "Produk tidak ditemukan pada workspace aktif.",
  "dna-required": "Product DNA belum tersedia. Generate Product DNA terlebih dahulu.",
  "invalid-platform": "Platform video tidak valid.",
  "invalid-tone": "Tone UGC tidak valid.",
  "invalid-duration": "Durasi video tidak valid.",
  "storyboard-generation-failed": "Provider AI gagal membuat UGC storyboard. Diagnostic ID tersedia di URL untuk troubleshooting aman.",
  "storyboard-persist-failed": "Storyboard berhasil diproses tetapi gagal disimpan ke database.",
};

function platformLabel(value: string) {
  return value === "shopee_video" ? "Shopee Video" : value === "tiktok" ? "TikTok" : value;
}

export default async function GeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; product?: string; diag?: string; provider?: string; reason?: string; status?: string }>;
}) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) return null;
  const query = await searchParams;
  const [products, storyboards] = await Promise.all([
    readDnaReadyProducts(workspace),
    readRecentStoryboards(workspace),
  ]);
  const canMutate = workspace.role === "owner" || workspace.role === "admin";

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-600"><Sparkles className="size-3.5" /> F6 · UGC Storyboard</div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em]">Generate UGC script & storyboard</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">Product DNA menjadi authoritative context. Script hanya boleh memakai evidence yang didukung DNA dan harus menghormati cautions dari Product Accuracy Lock.</p>
          </div>
          <div className="rounded-xl border bg-white px-4 py-3 text-sm text-neutral-500"><span className="font-semibold text-neutral-900">{products.length}</span> DNA Ready products</div>
        </div>

        {query.error ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><p className="font-semibold">{errorMessages[query.error] ?? "Generation gagal diproses."}</p>{query.diag ? <p className="mt-1 text-xs text-red-500">Diagnostic {query.diag} · {query.provider ?? "provider"}{query.reason ? ` · ${query.reason}` : ""}{query.status ? ` · HTTP ${query.status}` : ""}</p> : null}</div> : null}

        <section className="mt-8 grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold">Creative brief</p><p className="mt-1 text-sm leading-6 text-neutral-500">Pilih produk dan format. Gemini akan menyusun scene yang production-ready.</p></div><Clapperboard className="size-5 text-neutral-400" /></div>

            {!canMutate ? <div className="mt-5 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-500">Role member hanya dapat membaca storyboard. Generate tersedia untuk owner/admin.</div> : products.length === 0 ? <div className="mt-5 rounded-xl border border-dashed bg-neutral-50 p-5"><div className="flex items-start gap-3"><Dna className="mt-0.5 size-5 text-neutral-400" /><div><p className="text-sm font-semibold">Belum ada Product DNA</p><p className="mt-1 text-sm leading-6 text-neutral-500">Generate Product DNA pada halaman produk terlebih dahulu sebelum membuat UGC storyboard.</p><Link href="/app/products" className="mt-3 inline-flex text-sm font-semibold text-neutral-900 underline underline-offset-4">Buka Products</Link></div></div></div> : <form action={generateStoryboardAction} className="mt-6 space-y-4">
              <label className="block"><span className="text-xs font-semibold text-neutral-600">Product DNA</span><select name="productId" defaultValue={query.product && products.some((item) => item.id === query.product) ? query.product : products[0]?.id} required className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm">{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-xs font-semibold text-neutral-600">Platform</span><select name="platform" defaultValue="tiktok" className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="tiktok">TikTok</option><option value="shopee_video">Shopee Video</option></select></label>
                <label className="block"><span className="text-xs font-semibold text-neutral-600">Duration</span><select name="durationSeconds" defaultValue="30" className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="45">45 seconds</option></select></label>
              </div>
              <label className="block"><span className="text-xs font-semibold text-neutral-600">UGC tone</span><select name="tone" defaultValue="natural" className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="natural">Natural / authentic</option><option value="energetic">Energetic</option><option value="problem_solution">Problem → solution</option><option value="testimonial">Testimonial style</option></select></label>
              <label className="block"><span className="text-xs font-semibold text-neutral-600">Creative angle <span className="font-normal text-neutral-400">optional</span></span><textarea name="creativeAngle" maxLength={240} rows={3} placeholder="Contoh: snack discovery saat kerja, fokus tekstur dan cara menikmatinya tanpa menambah klaim baru." className="mt-2 w-full rounded-xl border bg-white p-3 text-sm leading-6" /></label>
              <div className="flex items-start gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-xs leading-5 text-emerald-800"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><span>Product Accuracy Lock aktif: observed claims boleh dipakai sebagai evidence; inferred opportunities tidak boleh berubah menjadi fakta.</span></div>
              <button type="submit" className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-semibold text-white hover:bg-neutral-800"><Sparkles className="size-4" /> Generate UGC Storyboard</button>
            </form>}
          </article>

          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold">Recent storyboards</p><p className="mt-1 text-sm text-neutral-500">Draft creative yang sudah tersimpan via RLS.</p></div><Film className="size-5 text-neutral-400" /></div>
            {storyboards.length === 0 ? <div className="mt-6 rounded-xl border border-dashed bg-neutral-50 p-6 text-sm leading-6 text-neutral-500">Belum ada storyboard. Generate konsep pertama dari Product DNA di panel sebelah kiri.</div> : <div className="mt-5 space-y-3">{storyboards.map((storyboard) => <Link key={storyboard.id} href={`/app/generate/${storyboard.id}`} className="block rounded-xl border p-4 transition hover:border-neutral-300 hover:bg-neutral-50"><div className="flex items-start justify-between gap-4"><div><p className="font-semibold text-neutral-900">{storyboard.title}</p><p className="mt-1 text-sm text-neutral-500">{storyboard.productName}</p></div><span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold capitalize text-neutral-600">{storyboard.status}</span></div><div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-500"><span className="rounded-full bg-neutral-100 px-2.5 py-1">{platformLabel(storyboard.platform)}</span>{storyboard.durationSeconds ? <span className="rounded-full bg-neutral-100 px-2.5 py-1">{storyboard.durationSeconds}s</span> : null}<span>{new Date(storyboard.createdAt).toLocaleString("id-ID")}</span></div></Link>)}</div>}
          </article>
        </section>
      </div>
    </main>
  );
}
