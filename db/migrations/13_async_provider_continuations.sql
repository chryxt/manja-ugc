BEGIN;

ALTER TABLE public.job_dispatch_outbox
  ADD COLUMN dispatch_key TEXT;

UPDATE public.job_dispatch_outbox
SET dispatch_key = 'initial:' || job_id::text
WHERE dispatch_key IS NULL;

ALTER TABLE public.job_dispatch_outbox
  ALTER COLUMN dispatch_key SET NOT NULL,
  DROP CONSTRAINT uq_job_dispatch_outbox_job,
  ADD CONSTRAINT uq_job_dispatch_outbox_dispatch_key UNIQUE (dispatch_key);

CREATE OR REPLACE FUNCTION private.trg_enqueue_job_to_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'queued' THEN
    INSERT INTO public.job_dispatch_outbox(
      job_id, workspace_id, queue_name, payload, dispatch_key
    ) VALUES (
      NEW.id,
      NEW.workspace_id,
      'ugc-jobs',
      pg_catalog.jsonb_build_object('jobId', NEW.id),
      'initial:' || NEW.id::text
    )
    ON CONFLICT (dispatch_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Crash-safe start primitive. If an earlier worker died while an operation was still
-- non-terminal, return the same operation UUID so provider idempotency keys remain stable.
CREATE OR REPLACE FUNCTION private.resume_or_start_job_operation(
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
  v_existing_id UUID;
  v_existing_provider public.ai_provider;
  v_existing_type TEXT;
  v_existing_status public.job_operation_status;
  v_attempt INTEGER;
  v_operation_id UUID;
BEGIN
  SELECT j.workspace_id,j.status
  INTO v_workspace_id,v_job_status
  FROM public.jobs j
  JOIN public.workspaces w ON w.id=j.workspace_id
  WHERE j.id=p_job_id AND w.deleted_at IS NULL
  FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found or workspace inactive' USING ERRCODE='P0002';
  END IF;
  IF v_job_status NOT IN ('processing','waiting_provider','rendering') THEN
    RAISE EXCEPTION 'Job state % does not allow operations',v_job_status USING ERRCODE='22023';
  END IF;

  SELECT id,provider,operation_type,status
  INTO v_existing_id,v_existing_provider,v_existing_type,v_existing_status
  FROM public.job_operations
  WHERE job_id=p_job_id AND operation_key=p_operation_key
  ORDER BY attempt_number DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_existing_status IN ('created','submitted','in_progress') THEN
    IF v_existing_provider<>p_provider OR v_existing_type<>p_operation_type THEN
      RAISE EXCEPTION 'Active operation identity conflict' USING ERRCODE='22023';
    END IF;
    RETURN v_existing_id;
  END IF;

  SELECT COALESCE(MAX(attempt_number),0)+1
  INTO v_attempt
  FROM public.job_operations
  WHERE job_id=p_job_id AND operation_key=p_operation_key;

  INSERT INTO public.job_operations(
    workspace_id,job_id,provider,operation_key,operation_type,status,
    attempt_number,request_metadata,started_at
  ) VALUES (
    v_workspace_id,p_job_id,p_provider,p_operation_key,p_operation_type,'in_progress',
    v_attempt,p_request_metadata,pg_catalog.now()
  ) RETURNING id INTO v_operation_id;

  RETURN v_operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_job_operation_submission(
  p_job_id UUID,
  p_operation_id UUID,
  p_provider_operation_id TEXT,
  p_response_metadata JSONB DEFAULT NULL
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
  IF p_provider_operation_id IS NULL OR pg_catalog.btrim(p_provider_operation_id) = '' THEN
    RAISE EXCEPTION 'Provider operation id required' USING ERRCODE='22023';
  END IF;

  SELECT workspace_id,status
  INTO v_workspace_id,v_job_status
  FROM public.jobs
  WHERE id=p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE='P0002';
  END IF;
  IF v_job_status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'Terminal job cannot accept provider submission' USING ERRCODE='22023';
  END IF;

  SELECT status,provider_operation_id
  INTO v_op_status,v_existing_provider_operation_id
  FROM public.job_operations
  WHERE id=p_operation_id
    AND job_id=p_job_id
    AND workspace_id=v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation not found for job' USING ERRCODE='P0002';
  END IF;

  IF v_existing_provider_operation_id IS NOT NULL
     AND v_existing_provider_operation_id <> p_provider_operation_id THEN
    RAISE EXCEPTION 'Provider operation id conflict' USING ERRCODE='22023';
  END IF;

  IF v_op_status IN ('succeeded','failed','cancelled') THEN
    IF v_existing_provider_operation_id = p_provider_operation_id THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Terminal operation cannot accept provider submission' USING ERRCODE='22023';
  END IF;

  UPDATE public.job_operations
  SET status='submitted',
      provider_operation_id=p_provider_operation_id,
      response_metadata=p_response_metadata,
      updated_at=pg_catalog.now()
  WHERE id=p_operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.schedule_job_wakeup(
  p_job_id UUID,
  p_operation_id UUID,
  p_delay_seconds INTEGER DEFAULT 15
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_workspace_id UUID;
  v_job_status public.job_status_enum;
  v_op_status public.job_operation_status;
  v_outbox_id UUID;
  v_dispatch_key TEXT;
BEGIN
  IF p_delay_seconds < 1 OR p_delay_seconds > 3600 THEN
    RAISE EXCEPTION 'Wakeup delay out of range' USING ERRCODE='22023';
  END IF;

  SELECT workspace_id,status
  INTO v_workspace_id,v_job_status
  FROM public.jobs
  WHERE id=p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE='P0002';
  END IF;
  IF v_job_status NOT IN ('processing','waiting_provider','rendering') THEN
    RAISE EXCEPTION 'Job state % does not allow provider wakeup',v_job_status USING ERRCODE='22023';
  END IF;

  SELECT status INTO v_op_status
  FROM public.job_operations
  WHERE id=p_operation_id
    AND job_id=p_job_id
    AND workspace_id=v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation not found for job' USING ERRCODE='P0002';
  END IF;
  IF v_op_status NOT IN ('submitted','in_progress') THEN
    RAISE EXCEPTION 'Operation state % does not allow wakeup',v_op_status USING ERRCODE='22023';
  END IF;

  v_dispatch_key := 'provider-wakeup:' || p_operation_id::text;

  INSERT INTO public.job_dispatch_outbox(
    job_id, workspace_id, queue_name, payload, dispatch_key, available_at
  ) VALUES (
    p_job_id,
    v_workspace_id,
    'ugc-jobs',
    pg_catalog.jsonb_build_object('jobId', p_job_id),
    v_dispatch_key,
    pg_catalog.now() + pg_catalog.make_interval(secs => p_delay_seconds)
  )
  ON CONFLICT (dispatch_key) DO UPDATE
    SET status='pending',
        claim_token=NULL,
        claimed_by=NULL,
        lease_expires_at=NULL,
        available_at=EXCLUDED.available_at,
        last_error=NULL,
        completed_at=NULL,
        updated_at=pg_catalog.now()
    WHERE public.job_dispatch_outbox.status IN ('completed','failed','pending')
  RETURNING id INTO v_outbox_id;

  IF v_outbox_id IS NULL THEN
    RAISE EXCEPTION 'Provider wakeup is currently being dispatched' USING ERRCODE='55000';
  END IF;

  RETURN v_outbox_id;
END;
$$;

DROP FUNCTION private.claim_outbox_messages(TEXT, INTEGER, INTEGER);

CREATE FUNCTION private.claim_outbox_messages(
  p_dispatcher_id TEXT,
  p_batch_size INTEGER DEFAULT 50,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE(
  outbox_id UUID,
  job_id UUID,
  queue_name TEXT,
  payload JSONB,
  claim_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_dispatcher_id IS NULL OR pg_catalog.btrim(p_dispatcher_id) = '' THEN
    RAISE EXCEPTION 'dispatcher id required' USING ERRCODE='22023';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'batch size out of range' USING ERRCODE='22023';
  END IF;
  IF p_lease_seconds < 5 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'lease seconds out of range' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT o.id
    FROM public.job_dispatch_outbox o
    WHERE (
      (o.status='pending' AND o.available_at <= pg_catalog.now())
      OR
      (o.status='processing' AND o.lease_expires_at < pg_catalog.now())
    )
    ORDER BY o.available_at,o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.job_dispatch_outbox o
     SET status='processing',
         attempt_count=o.attempt_count+1,
         claim_token=pg_catalog.gen_random_uuid(),
         claimed_by=p_dispatcher_id,
         lease_expires_at=pg_catalog.now()+pg_catalog.make_interval(secs=>p_lease_seconds),
         last_error=CASE WHEN o.status='processing' THEN 'stale dispatch lease recovered' ELSE o.last_error END,
         updated_at=pg_catalog.now()
    FROM eligible e
   WHERE o.id=e.id
  RETURNING o.id,o.job_id,o.queue_name,o.payload,o.claim_token,o.lease_expires_at,o.attempt_count;
END;
$$;

REVOKE ALL ON FUNCTION private.resume_or_start_job_operation(UUID,public.ai_provider,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.record_job_operation_submission(UUID,UUID,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.schedule_job_wakeup(UUID,UUID,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.claim_outbox_messages(TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.resume_or_start_job_operation(UUID,public.ai_provider,TEXT,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION private.record_job_operation_submission(UUID,UUID,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION private.schedule_job_wakeup(UUID,UUID,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION private.claim_outbox_messages(TEXT,INTEGER,INTEGER) TO service_role;

COMMIT;
