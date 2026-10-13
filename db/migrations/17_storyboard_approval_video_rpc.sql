BEGIN;

ALTER TABLE public.storyboards
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.approve_storyboard(
  p_storyboard_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_workspace_id UUID;
  v_status TEXT;
  v_role public.workspace_role;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  SELECT s.workspace_id, s.status
    INTO v_workspace_id, v_status
  FROM public.storyboards s
  WHERE s.id = p_storyboard_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storyboard not found' USING ERRCODE='P0002';
  END IF;

  SELECT wm.role INTO v_role
  FROM public.workspace_members wm
  JOIN public.workspaces w ON w.id = wm.workspace_id
  WHERE wm.workspace_id = v_workspace_id
    AND wm.user_id = v_actor
    AND w.deleted_at IS NULL;

  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Owner or admin role required' USING ERRCODE='42501';
  END IF;

  IF v_status = 'approved' THEN
    RETURN p_storyboard_id;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft storyboards can be approved' USING ERRCODE='22023';
  END IF;

  UPDATE public.storyboards
     SET status = 'approved',
         approved_at = pg_catalog.now(),
         approved_by = v_actor,
         updated_at = pg_catalog.now()
   WHERE id = p_storyboard_id;

  INSERT INTO public.audit_logs(workspace_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES(v_workspace_id, v_actor, 'STORYBOARD_APPROVED', 'STORYBOARD', p_storyboard_id, '{}'::jsonb);

  RETURN p_storyboard_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_ugc_video_job(
  p_storyboard_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_workspace_id UUID;
  v_product_id UUID;
  v_status TEXT;
  v_role public.workspace_role;
  v_job_id UUID;
  v_idempotency_key TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  SELECT s.workspace_id, s.product_id, s.status
    INTO v_workspace_id, v_product_id, v_status
  FROM public.storyboards s
  WHERE s.id = p_storyboard_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storyboard not found' USING ERRCODE='P0002';
  END IF;

  SELECT wm.role INTO v_role
  FROM public.workspace_members wm
  JOIN public.workspaces w ON w.id = wm.workspace_id
  WHERE wm.workspace_id = v_workspace_id
    AND wm.user_id = v_actor
    AND w.deleted_at IS NULL;

  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Owner or admin role required' USING ERRCODE='42501';
  END IF;

  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'Storyboard must be approved before video generation' USING ERRCODE='22023';
  END IF;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Storyboard has no product binding' USING ERRCODE='22023';
  END IF;

  v_idempotency_key := 'ugc-video:' || p_storyboard_id::TEXT;

  v_job_id := private.create_domain_job_and_reserve_credits(
    v_workspace_id,
    'ugc_video',
    v_actor,
    v_idempotency_key,
    v_product_id,
    p_storyboard_id
  );

  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_storyboard(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_ugc_video_job(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_storyboard(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_ugc_video_job(UUID) TO authenticated;

COMMIT;
