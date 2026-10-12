import Link from "next/link";
import { ArrowLeft, Boxes } from "lucide-react";

import { createProduct } from "../actions";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const errorMessages: Record<string, string> = {
  "no-workspace": "Workspace aktif tidak ditemukan.",
  forbidden: "Role kamu tidak memiliki izin membuat produk.",
  "invalid-name": "Nama produk wajib 2–120 karakter.",
  "description-too-long": "Deskripsi maksimal 2.000 karakter.",
};

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const workspace = await resolveActiveWorkspace();
  const { error } = await searchParams;
  const canCreate = workspace?.role === "owner" || workspace?.role === "admin";
  const message = error ? errorMessages[error] ?? `Gagal membuat produk (${error}).` : null;

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-3xl">
        <Link href="/app/products" className="inline-flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-950"><ArrowLeft className="size-4" /> Kembali ke Products</Link>
        <div className="mt-6 rounded-2xl border bg-white p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="grid size-11 place-items-center rounded-xl bg-neutral-950 text-white"><Boxes className="size-5" /></span>
            <div><p className="text-sm font-medium text-neutral-500">F4A · New product</p><h1 className="mt-1 text-2xl font-semibold">Tambahkan produk</h1><p className="mt-2 text-sm leading-6 text-neutral-500">Buat record produk terlebih dulu. Upload source image dan Product DNA akan dilanjutkan pada checkpoint berikutnya.</p></div>
          </div>

          {message ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div> : null}
          {!canCreate ? (
            <div className="mt-6 rounded-xl border bg-neutral-50 px-4 py-4 text-sm text-neutral-600">Hanya owner atau admin workspace yang dapat membuat produk.</div>
          ) : (
            <form action={createProduct} className="mt-7 space-y-5">
              <div><label htmlFor="name" className="text-sm font-semibold">Nama produk</label><input id="name" name="name" required minLength={2} maxLength={120} placeholder="Contoh: Putto Kacang Kapri 300g" className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm outline-none transition focus:border-neutral-500" /></div>
              <div><label htmlFor="description" className="text-sm font-semibold">Deskripsi <span className="font-normal text-neutral-400">(opsional)</span></label><textarea id="description" name="description" maxLength={2000} rows={6} placeholder="Ringkasan produk, rasa, target pembeli, atau catatan internal." className="mt-2 w-full resize-y rounded-xl border bg-white px-3 py-3 text-sm leading-6 outline-none transition focus:border-neutral-500" /></div>
              <div className="flex items-center justify-end gap-3 border-t pt-5"><Link href="/app/products" className="inline-flex h-10 items-center rounded-xl border bg-white px-4 text-sm font-semibold text-neutral-600">Batal</Link><button type="submit" className="h-10 rounded-xl bg-neutral-950 px-5 text-sm font-semibold text-white hover:bg-neutral-800">Simpan produk</button></div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
