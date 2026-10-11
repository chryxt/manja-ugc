BEGIN;

CREATE OR REPLACE FUNCTION private.user_has_workspace_role(
  target_workspace_id UUID,
  allowed_roles public.workspace_role[]
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    JOIN public.workspace_members wm ON wm.workspace_id = w.id
    WHERE w.id = target_workspace_id
      AND w.deleted_at IS NULL
      AND wm.user_id = auth.uid()
      AND wm.role = ANY(allowed_roles)
  );
$$;

REVOKE ALL ON FUNCTION private.user_has_workspace_role(UUID, public.workspace_role[]) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.user_has_workspace_role(UUID, public.workspace_role[]) TO authenticated;

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storyboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.workspaces, public.workspace_members, public.products, public.product_assets,
  public.storyboards, public.jobs, public.video_jobs, public.credit_accounts,
  public.credit_reservations, public.credit_transactions, public.audit_logs
FROM PUBLIC, anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON public.workspaces, public.workspace_members, public.jobs, public.video_jobs,
   public.credit_accounts, public.credit_reservations, public.credit_transactions, public.audit_logs
FROM authenticated;

GRANT SELECT ON public.workspaces, public.workspace_members, public.products, public.product_assets,
  public.storyboards, public.jobs, public.video_jobs, public.credit_accounts,
  public.credit_reservations, public.credit_transactions, public.audit_logs
TO authenticated;

GRANT INSERT, UPDATE, DELETE ON public.products, public.product_assets, public.storyboards TO authenticated;

CREATE POLICY workspace_select ON public.workspaces
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(id, ARRAY['owner','admin','member']::public.workspace_role[]));

CREATE POLICY workspace_members_select ON public.workspace_members
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));

CREATE POLICY products_select ON public.products
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));
CREATE POLICY products_insert ON public.products
FOR INSERT TO authenticated
WITH CHECK (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY products_update ON public.products
FOR UPDATE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY products_delete ON public.products
FOR DELETE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));

CREATE POLICY product_assets_select ON public.product_assets
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));
CREATE POLICY product_assets_insert ON public.product_assets
FOR INSERT TO authenticated
WITH CHECK (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY product_assets_update ON public.product_assets
FOR UPDATE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY product_assets_delete ON public.product_assets
FOR DELETE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));

CREATE POLICY storyboards_select ON public.storyboards
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));
CREATE POLICY storyboards_insert ON public.storyboards
FOR INSERT TO authenticated
WITH CHECK (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY storyboards_update ON public.storyboards
FOR UPDATE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY storyboards_delete ON public.storyboards
FOR DELETE TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));

CREATE POLICY jobs_select ON public.jobs
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));
CREATE POLICY video_jobs_select ON public.video_jobs
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));
CREATE POLICY credit_accounts_select ON public.credit_accounts
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
CREATE POLICY credit_reservations_select ON public.credit_reservations
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));
CREATE POLICY credit_transactions_select ON public.credit_transactions
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));
CREATE POLICY audit_logs_select ON public.audit_logs
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_role[]));

COMMIT;
