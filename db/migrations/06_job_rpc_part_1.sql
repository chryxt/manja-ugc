BEGIN;

CREATE OR REPLACE FUNCTION private.get_job_price(
  p_job_type TEXT,
  OUT cost_snapshot INTEGER,
  OUT pricing_version TEXT
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  CASE p_job_type
    WHEN 'product_dna' THEN cost_snapshot := 10; pricing_version := 'v1.0-2026';
    WHEN 'catalog_image' THEN cost_snapshot := 25; pricing_version := 'v1.0-2026';
    WHEN 'ugc_video' THEN cost_snapshot := 150; pricing_version := 'v1.0-2026';
    ELSE RAISE EXCEPTION 'Unknown job_type: %', p_job_type USING ERRCODE='22023';
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION private.validate_job_transition(
  p_current_status public.job_status_enum,
  p_new_status public.job_status_enum
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_current_status IN ('completed','failed','cancelled') THEN RETURN FALSE; END IF;
  CASE p_current_status
    WHEN 'queued' THEN RETURN p_new_status IN ('processing','cancelled','failed');
    WHEN 'processing' THEN RETURN p_new_status IN ('waiting_provider','rendering','completed','failed','cancelled');
    WHEN 'waiting_provider' THEN RETURN p_new_status IN ('processing','rendering','failed','cancelled');
    WHEN 'rendering' THEN RETURN p_new_status IN ('completed','failed','cancelled');
    ELSE RETURN FALSE;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_job_and_reserve_credits(
  p_workspace_id UUID,
  p_job_type TEXT,
  p_actor_user_id UUID,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role public.workspace_role;
  v_existing_id UUID;
  v_existing_type TEXT;
  v_job_id UUID;
  v_reservation_id UUID;
  v_cost INTEGER;
  v_pricing TEXT;
  v_balance INTEGER;
  v_reserved INTEGER;
BEGIN
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'Actor user is required' USING ERRCODE='22023'; END IF;

  SELECT wm.role INTO v_role
  FROM public.workspaces w
  JOIN public.workspace_members wm ON wm.workspace_id=w.id
  WHERE w.id=p_workspace_id AND w.deleted_at IS NULL AND wm.user_id=p_actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Actor is not an active workspace member' USING ERRCODE='42501'; END IF;

  SELECT cost_snapshot,pricing_version INTO v_cost,v_pricing FROM private.get_job_price(p_job_type);

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id,job_type INTO v_existing_id,v_existing_type
    FROM public.jobs WHERE workspace_id=p_workspace_id AND idempotency_key=p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN
      IF v_existing_type<>p_job_type THEN RAISE EXCEPTION 'Idempotency key conflict' USING ERRCODE='22023'; END IF;
      RETURN v_existing_id;
    END IF;
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE='P0002'; END IF;

  SELECT role INTO v_role FROM public.workspace_members
  WHERE workspace_id=p_workspace_id AND user_id=p_actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Actor is no longer a workspace member' USING ERRCODE='42501'; END IF;

  SELECT balance,reserved_credits INTO v_balance,v_reserved
  FROM public.credit_accounts WHERE workspace_id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit account not found' USING ERRCODE='P0002'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id,job_type INTO v_existing_id,v_existing_type
    FROM public.jobs WHERE workspace_id=p_workspace_id AND idempotency_key=p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN
      IF v_existing_type<>p_job_type THEN RAISE EXCEPTION 'Idempotency key conflict' USING ERRCODE='22023'; END IF;
      RETURN v_existing_id;
    END IF;
  END IF;

  IF (v_balance-v_reserved)<v_cost THEN RAISE EXCEPTION 'Insufficient available credits' USING ERRCODE='P0001'; END IF;

  INSERT INTO public.jobs(workspace_id,job_type,status,cost_snapshot,pricing_version,idempotency_key,created_by)
  VALUES(p_workspace_id,p_job_type,'queued',v_cost,v_pricing,p_idempotency_key,p_actor_user_id)
  RETURNING id INTO v_job_id;

  INSERT INTO public.credit_reservations(workspace_id,job_id,amount,status)
  VALUES(p_workspace_id,v_job_id,v_cost,'RESERVED') RETURNING id INTO v_reservation_id;

  UPDATE public.credit_accounts
  SET reserved_credits=reserved_credits+v_cost, updated_at=now()
  WHERE workspace_id=p_workspace_id;

  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(p_workspace_id,p_actor_user_id,'JOB_CREATED_AND_RESERVED','JOB',v_job_id,
    jsonb_build_object('job_type',p_job_type,'cost',v_cost,'reservation_id',v_reservation_id,'idempotency_key',p_idempotency_key));

  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION private.get_job_price(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.validate_job_transition(public.job_status_enum,public.job_status_enum) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.create_job_and_reserve_credits(UUID,TEXT,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.create_job_and_reserve_credits(UUID,TEXT,UUID,TEXT) TO service_role;

COMMIT;
