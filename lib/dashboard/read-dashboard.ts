import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export type DashboardJob = {
  id: string;
  jobType: string;
  status: "queued" | "processing" | "waiting_provider" | "rendering" | "completed" | "failed" | "cancelled";
  progress: number;
  costSnapshot: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDashboard = {
  productCount: number;
  activeJobCount: number;
  completedJobCount: number;
  failedJobCount: number;
  credits: {
    balance: number;
    reserved: number;
    available: number;
  } | null;
  recentJobs: DashboardJob[];
};

const ACTIVE_STATUSES = ["queued", "processing", "waiting_provider", "rendering"] as const;

export async function readWorkspaceDashboard(
  workspace: ActiveWorkspace,
): Promise<WorkspaceDashboard> {
  const supabase = await createServerSupabaseClient();

  const [productsResult, activeJobsResult, completedJobsResult, failedJobsResult, recentJobsResult] =
    await Promise.all([
      supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id),
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id)
        .in("status", [...ACTIVE_STATUSES]),
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id)
        .eq("status", "completed"),
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id)
        .eq("status", "failed"),
      supabase
        .from("jobs")
        .select("id, job_type, status, progress, cost_snapshot, created_at, updated_at")
        .eq("workspace_id", workspace.id)
        .order("created_at", { ascending: false })
        .limit(6),
    ]);

  for (const [label, result] of [
    ["products", productsResult],
    ["active jobs", activeJobsResult],
    ["completed jobs", completedJobsResult],
    ["failed jobs", failedJobsResult],
    ["recent jobs", recentJobsResult],
  ] as const) {
    if (result.error) {
      throw new Error(`Failed to read dashboard ${label}: ${result.error.message}`);
    }
  }

  let credits: WorkspaceDashboard["credits"] = null;
  if (workspace.role === "owner" || workspace.role === "admin") {
    const { data: creditAccount, error: creditError } = await supabase
      .from("credit_accounts")
      .select("balance, reserved_credits")
      .eq("workspace_id", workspace.id)
      .maybeSingle();

    if (creditError) {
      throw new Error(`Failed to read dashboard credits: ${creditError.message}`);
    }

    if (creditAccount) {
      credits = {
        balance: creditAccount.balance,
        reserved: creditAccount.reserved_credits,
        available: creditAccount.balance - creditAccount.reserved_credits,
      };
    }
  }

  return {
    productCount: productsResult.count ?? 0,
    activeJobCount: activeJobsResult.count ?? 0,
    completedJobCount: completedJobsResult.count ?? 0,
    failedJobCount: failedJobsResult.count ?? 0,
    credits,
    recentJobs: (recentJobsResult.data ?? []).map((job) => ({
      id: job.id,
      jobType: job.job_type,
      status: job.status as DashboardJob["status"],
      progress: job.progress,
      costSnapshot: job.cost_snapshot,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
  };
}
