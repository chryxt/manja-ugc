import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Camera, Captions, CheckCircle2, Clapperboard, Coins, Film, LoaderCircle, MessageSquareText, Play, ShieldAlert, Sparkles } from "lucide-react";

import { approveStoryboardAction, generateVideoAction } from "@/app/app/generate/actions";
import { readStoryboardDetail } from "@/lib/storyboards/storyboard-queries";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}
function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function platformLabel(value: string) {
  return value === "shopee_video" ? "Shopee Video" : value === "tiktok" ? "TikTok" : value;
}
function jobLabel(status: string) {
  if (status === "queued") return "Queued";
  if (status === "processing") return "Preparing";
  if (status === "waiting_provider") return "Provider rendering";
  if (status === "rendering") return "Persisting video";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return status;
}

const errorMessages: Record<string, string> = {
  forbidden: "Role kamu tidak diizinkan melakukan aksi ini.",
  "storyboard-not-found": "Storyboard tidak ditemukan pada workspace ini.",
  "approval-invalid-state": "Storyboard ini tidak berada pada status draft yang dapat disetujui.",
  "approval-failed": "Storyboard gagal disetujui.",
  "approval-required": "Storyboard harus Approved sebelum video dapat dibuat.",
  "insufficient-credits": "Credit tersedia tidak cukup untuk mereservasi render UGC video (150 credits).",
  "video-job-failed": "Render job gagal dibuat. Tidak ada credit yang boleh dipotong tanpa job yang valid.",
};

export default async function StoryboardDetailPage({ params, searchParams }: {
  params: Promise<{ storyboardId: string }>;
  searchParams: Promise<{ created?: string; approved?: string; video?: string; job?: string; error?: string }>;
}) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) notFound();
  const { storyboardId } = await params;
  const query = await searchParams;
  const storyboard = await readStoryboardDetail(workspace, storyboardId);
  if (!storyboard) notFound();

  const payload = storyboard.payload;
  const scenes = Array.isArray(payload.scenes) ? payload.scenes.map(asRecord) : [];
  const hashtags = asStringArray(payload.hashtags);
  const evidenceSummary = asStringArray(payload.evidenceSummary);
  const cautions = asStringArray(payload.cautions);
  const dnaLineage = asRecord(payload.dnaLineage);
  const duration = asNumber(payload.durationSeconds);
  const platform = asString(payload.platform);
  const productHref = storyboard.productId ? `/app/products/${storyboard.productId}` : "/app/products";
  const canMutate = workspace.role === "owner" || workspace.role === "admin";
  const approveAction = approveStoryboardAction.bind(null, storyboard.id);
  const videoAction = generateVideoAction.bind(null, storyboard.id);
  const latestJob = storyboard.renderJobs[0] ?? null;
  const latestVideo = storyboard.generatedVideos[0] ?? null;
  const renderInFlight = latestJob && ["queued", "processing", "waiting_provider", "rendering"].includes(latestJob.status);

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <Link href="/app/generate" className="inline-flex items-center gap-2 text-sm font-medium text-neutral-500 hover:text-neutral-950"><ArrowLeft className="size-4" /> Generate</Link>

        <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4"><span className="grid size-12 place-items-center rounded-2xl bg-neutral-950 text-white"><Clapperboard className="size-5" /></span><div><p className="text-sm font-medium text-neutral-500">UGC storyboard · {storyboard.productName}</p><h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">{asString(payload.title, "UGC Concept")}</h1><div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-500"><span className="rounded-full bg-neutral-100 px-3 py-1.5">{platformLabel(platform)}</span>{duration ? <span className="rounded-full bg-neutral-100 px-3 py-1.5">{duration}s</span> : null}<span className="rounded-full bg-neutral-100 px-3 py-1.5 capitalize">{asString(payload.tone, "natural")}</span><span className={`rounded-full px-3 py-1.5 font-semibold capitalize ${storyboard.status === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{storyboard.status}</span></div></div></div>
          <Link href={productHref} className="rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">View Product DNA</Link>
        </div>

        {query.created ? <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">UGC storyboard berhasil dibuat dari Product DNA dan tersimpan sebagai draft.</div> : null}
        {query.approved ? <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">Storyboard Approved. Konsep sekarang terkunci sebagai input render video.</div> : null}
        {query.video === "queued" ? <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700">Render job berhasil dibuat, 150 credits di-reserve, dan job dikirim ke durable provider pipeline.</div> : null}
        {query.error ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{errorMessages[query.error] ?? "Aksi gagal diproses."}</div> : null}

        <section className="mt-8 rounded-2xl border bg-white p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2"><Film className="size-5 text-neutral-500" /><p className="text-sm font-semibold">F7 · Approval & video pipeline</p></div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">Approval memisahkan creative draft dari render input. Generate Video membuat job `ugc_video` melalui RPC authoritative, mereservasi 150 credits, lalu trigger outbox → worker → provider.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {storyboard.status === "draft" && canMutate ? <form action={approveAction}><button className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700" type="submit"><CheckCircle2 className="size-4" /> Approve storyboard</button></form> : null}
              {storyboard.status === "approved" && canMutate && !latestJob ? <form action={videoAction}><button className="inline-flex h-11 items-center gap-2 rounded-xl bg-neutral-950 px-5 text-sm font-semibold text-white hover:bg-neutral-800" type="submit"><Play className="size-4" /> Generate video · 150 credits</button></form> : null}
              {renderInFlight ? <span className="inline-flex h-11 items-center gap-2 rounded-xl bg-blue-50 px-4 text-sm font-semibold text-blue-700"><LoaderCircle className="size-4" /> {jobLabel(latestJob.status)}</span> : null}
            </div>
          </div>

          {storyboard.approvedAt ? <p className="mt-4 text-xs text-neutral-400">Approved {new Date(storyboard.approvedAt).toLocaleString("id-ID")}</p> : null}

          {latestJob ? <div className="mt-5 grid gap-3 md:grid-cols-4"><div className="rounded-xl bg-neutral-50 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Job status</p><p className="mt-2 text-sm font-semibold">{jobLabel(latestJob.status)}</p></div><div className="rounded-xl bg-neutral-50 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Progress</p><p className="mt-2 text-sm font-semibold">{latestJob.progress}%</p></div><div className="rounded-xl bg-neutral-50 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Reserved cost</p><p className="mt-2 flex items-center gap-1.5 text-sm font-semibold"><Coins className="size-4" /> {latestJob.costSnapshot} credits</p></div><div className="rounded-xl bg-neutral-50 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Current step</p><p className="mt-2 text-sm font-semibold">{latestJob.currentStep || "—"}</p></div></div> : null}
          {latestJob?.status === "failed" ? <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700"><span className="font-semibold">Render failed{latestJob.errorCode ? ` · ${latestJob.errorCode}` : ""}.</span> {latestJob.errorMessage ? <span>{latestJob.errorMessage}</span> : null}</div> : null}

          {latestVideo ? <div className="mt-6 overflow-hidden rounded-2xl border bg-neutral-950"><video className="aspect-[9/16] max-h-[720px] w-full bg-black object-contain" controls playsInline preload="metadata" src={latestVideo.streamUrl} /><div className="flex items-center justify-between gap-4 px-4 py-3 text-xs text-neutral-300"><span>Persisted private R2 asset</span><span>{latestVideo.mimeType}{latestVideo.durationSeconds ? ` · ${latestVideo.durationSeconds}s` : ""}</span></div></div> : null}
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <article className="rounded-2xl bg-neutral-950 p-6 text-white"><div className="flex items-center justify-between gap-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">Creative direction</p><Sparkles className="size-4 text-emerald-400" /></div><p className="mt-4 text-2xl font-semibold leading-9">{asString(payload.hook, "Hook belum tersedia.")}</p><p className="mt-4 text-sm leading-6 text-neutral-300">{asString(payload.objective, "Objective belum tersedia.")}</p><div className="mt-5 rounded-xl bg-white/10 p-4"><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">CTA</p><p className="mt-2 text-sm font-medium leading-6">{asString(payload.cta, "CTA belum tersedia.")}</p></div>{asString(payload.creativeAngle) ? <div className="mt-4 text-xs leading-5 text-neutral-400">Creative angle: <span className="text-neutral-200">{asString(payload.creativeAngle)}</span></div> : null}</article>
          <article className="rounded-2xl border bg-white p-6"><div className="flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" /><p className="text-sm font-semibold">Accuracy lineage</p></div><p className="mt-2 text-sm leading-6 text-neutral-500">Storyboard menyimpan snapshot evidence Product DNA saat generation, sehingga perubahan DNA berikutnya tidak mengubah konteks draft lama secara diam-diam.</p><dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-neutral-400">Storyboard model</dt><dd className="text-right font-medium text-neutral-700">{asString(payload.model, "—")}</dd></div><div className="flex justify-between gap-4"><dt className="text-neutral-400">DNA model</dt><dd className="text-right font-medium text-neutral-700">{asString(dnaLineage.model, "—")}</dd></div><div className="flex justify-between gap-4"><dt className="text-neutral-400">Source assets</dt><dd className="font-medium text-neutral-700">{asStringArray(dnaLineage.sourceAssetIds).length}</dd></div><div className="flex justify-between gap-4"><dt className="text-neutral-400">Generated</dt><dd className="text-right font-medium text-neutral-700">{asString(payload.generatedAt) ? new Date(asString(payload.generatedAt)).toLocaleString("id-ID") : "—"}</dd></div></dl></article>
        </section>

        <section className="mt-4 rounded-2xl border bg-white p-6"><div className="flex items-center justify-between gap-4"><div><p className="text-sm font-semibold">Scene-by-scene storyboard</p><p className="mt-1 text-sm text-neutral-500">Visual direction, camera, VO, overlay, evidence, dan guardrail per scene.</p></div><Camera className="size-5 text-neutral-400" /></div><div className="mt-6 space-y-4">{scenes.map((scene, index) => <article key={index} className="overflow-hidden rounded-2xl border"><div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-50 px-5 py-3"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-full bg-neutral-950 text-xs font-bold text-white">{index + 1}</span><div><p className="text-sm font-semibold">{asString(scene.purpose, `Scene ${index + 1}`)}</p><p className="text-xs text-neutral-400">{asNumber(scene.durationSeconds) ?? "—"} seconds</p></div></div><span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-neutral-500 shadow-sm">9:16 vertical</span></div><div className="grid gap-5 p-5 lg:grid-cols-2"><div><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Visual action</p><p className="mt-2 text-sm leading-6 text-neutral-700">{asString(scene.visual, "—")}</p><p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Camera</p><p className="mt-2 text-sm leading-6 text-neutral-700">{asString(scene.camera, "—")}</p></div><div><p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Voiceover</p><p className="mt-2 rounded-xl bg-neutral-950 p-4 text-sm font-medium leading-6 text-white">{asString(scene.voiceover, "—")}</p><p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">On-screen text</p><p className="mt-2 text-sm font-semibold text-neutral-800">{asString(scene.onScreenText, "—")}</p></div></div><div className="grid gap-3 border-t bg-neutral-50/70 p-5 sm:grid-cols-2"><div><p className="text-xs font-semibold text-emerald-700">Evidence used</p><ul className="mt-2 space-y-1.5">{asStringArray(scene.evidenceUsed).length ? asStringArray(scene.evidenceUsed).map((item) => <li key={item} className="text-xs leading-5 text-neutral-600">• {item}</li>) : <li className="text-xs text-neutral-400">No explicit claim used.</li>}</ul></div><div><p className="text-xs font-semibold text-amber-700">Guardrail</p><p className="mt-2 text-xs leading-5 text-neutral-600">{asString(scene.guardrail, "Jangan menambahkan unsupported claim.")}</p></div></div></article>)}</div></section>

        <section className="mt-4 grid gap-4 lg:grid-cols-2"><article className="rounded-2xl border bg-white p-6"><div className="flex items-center gap-2"><MessageSquareText className="size-4 text-neutral-500" /><p className="text-sm font-semibold">Full voiceover</p></div><p className="mt-4 whitespace-pre-line text-sm leading-7 text-neutral-700">{storyboard.scriptContent || asString(payload.fullVoiceover, "—")}</p></article><article className="rounded-2xl border bg-white p-6"><div className="flex items-center gap-2"><Captions className="size-4 text-neutral-500" /><p className="text-sm font-semibold">Caption & hashtags</p></div><p className="mt-4 text-sm leading-7 text-neutral-700">{asString(payload.caption, "—")}</p><div className="mt-4 flex flex-wrap gap-2">{hashtags.map((tag) => <span key={tag} className="rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-600">{tag}</span>)}</div></article></section>

        <section className="mt-4 grid gap-4 lg:grid-cols-2"><article className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-6"><p className="text-sm font-semibold text-emerald-800">Evidence actually used</p><ul className="mt-4 space-y-2">{evidenceSummary.length ? evidenceSummary.map((item) => <li key={item} className="text-sm leading-6 text-neutral-700">• {item}</li>) : <li className="text-sm text-neutral-500">Tidak ada evidence summary tambahan.</li>}</ul></article><article className="rounded-2xl border border-amber-100 bg-amber-50/50 p-6"><div className="flex items-center gap-2"><ShieldAlert className="size-4 text-amber-700" /><p className="text-sm font-semibold text-amber-800">Claims intentionally avoided</p></div><ul className="mt-4 space-y-2">{cautions.length ? cautions.map((item) => <li key={item} className="text-sm leading-6 text-neutral-700">• {item}</li>) : <li className="text-sm text-neutral-500">Tidak ada caution tambahan.</li>}</ul></article></section>
      </div>
    </main>
  );
}
