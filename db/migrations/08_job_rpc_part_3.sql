BEGIN;

CREATE OR REPLACE FUNCTION private.finalize_job_operation(
  p_job_id UUID,
  p_operation_id UUID,
  p_outcome public.job_operation_status,
  p_provider_operation_id TEXT DEFAULT NULL,
  p_response_metadata JSONB DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_workspace_id UUID;
  v_job_status public.job_status_enum;
  v_op_status public.job_operation_status;
  v_existing_provider_operation_id TEXT;
BEGIN
  IF p_outcome NOT IN ('succeeded','failed','cancelled') THEN
    RAISE EXCEPTION 'Operation outcome must be terminal' USING ERRCODE='22023';
  END IF;

  SELECT workspace_id,status INTO v_workspace_id,v_job_status
  FROM public.jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE='P0002'; END IF;

  SELECT status,provider_operation_id
  INTO v_op_status,v_existing_provider_operation_id
  FROM public.job_operations
  WHERE id=p_operation_id AND job_id=p_job_id AND workspace_id=v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation not found for job' USING ERRCODE='P0002'; END IF;

  IF v_op_status IN ('succeeded','failed','cancelled') THEN
    IF v_op_status<>p_outcome THEN
      RAISE EXCEPTION 'Operation terminal outcome conflict: existing %, requested %',v_op_status,p_outcome USING ERRCODE='22023';
    END IF;
    IF p_provider_operation_id IS NOT NULL
       AND v_existing_provider_operation_id IS NOT NULL
       AND p_provider_operation_id<>v_existing_provider_operation_id THEN
      RAISE EXCEPTION 'Provider operation id conflict' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;

  UPDATE public.job_operations
  SET status=p_outcome,
      provider_operation_id=COALESCE(p_provider_operation_id,provider_operation_id),
      response_metadata=p_response_metadata,
      completed_at=now(),
      error_code=p_error_code,
      error_message=p_error_message,
      updated_at=now()
  WHERE id=p_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION private.finalize_job_operation(UUID,UUID,public.job_operation_status,TEXT,JSONB,TEXT,TEXT)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.finalize_job_operation(UUID,UUID,public.job_operation_status,TEXT,JSONB,TEXT,TEXT)
TO service_role;

COMMIT;
