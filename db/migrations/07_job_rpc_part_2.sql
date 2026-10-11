BEGIN;

CREATE OR REPLACE FUNCTION private.transition_job_state(
  p_job_id UUID,
  p_new_status public.job_status_enum,
  p_current_step TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_workspace_id UUID;
  v_status public.job_status_enum;
BEGIN
  IF p_new_status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'Terminal transitions require finalize_job' USING ERRCODE='22023';
  END IF;

  SELECT j.workspace_id,j.status INTO v_workspace_id,v_status
  FROM public.jobs j
  JOIN public.workspaces w ON w.id=j.workspace_id
  WHERE j.id=p_job_id AND w.deleted_at IS NULL
  FOR UPDATE OF j;

  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found or workspace inactive' USING ERRCODE='P0002'; END IF;

  IF NOT private.validate_job_transition(v_status,p_new_status) THEN
    RAISE EXCEPTION 'Invalid job transition from % to %',v_status,p_new_status USING ERRCODE='22023';
  END IF;

  UPDATE public.jobs
  SET status=p_new_status,
      current_step=p_current_step,
      started_at=CASE WHEN v_status='queued' AND p_new_status='processing' AND started_at IS NULL THEN now() ELSE started_at END,
      updated_at=now()
  WHERE id=p_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.start_job_operation(
  p_job_id UUID,
  p_provider public.ai_provider,
  p_operation_key TEXT,
  p_operation_type TEXT,
  p_request_metadata JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_workspace_id UUID;
  v_job_status public.job_status_enum;
  v_attempt INTEGER;
  v_operation_id UUID;
BEGIN
  SELECT j.workspace_id,j.status INTO v_workspace_id,v_job_status
  FROM public.jobs j
  JOIN public.workspaces w ON w.id=j.workspace_id
  WHERE j.id=p_job_id AND w.deleted_at IS NULL
  FOR UPDATE OF j;

  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found or workspace inactive' USING ERRCODE='P0002'; END IF;

  IF v_job_status NOT IN ('processing','waiting_provider','rendering') THEN
    RAISE EXCEPTION 'Job state % does not allow new operations',v_job_status USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(MAX(attempt_number),0)+1 INTO v_attempt
  FROM public.job_operations
  WHERE job_id=p_job_id AND operation_key=p_operation_key;

  INSERT INTO public.job_operations(
    workspace_id,job_id,provider,operation_key,operation_type,status,
    attempt_number,request_metadata,started_at
  ) VALUES (
    v_workspace_id,p_job_id,p_provider,p_operation_key,p_operation_type,'in_progress',
    v_attempt,p_request_metadata,now()
  ) RETURNING id INTO v_operation_id;

  RETURN v_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION private.transition_job_state(UUID,public.job_status_enum,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.start_job_operation(UUID,public.ai_provider,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.transition_job_state(UUID,public.job_status_enum,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION private.start_job_operation(UUID,public.ai_provider,TEXT,TEXT,JSONB) TO service_role;

COMMIT;
