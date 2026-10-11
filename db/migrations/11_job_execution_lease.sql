BEGIN;

CREATE TABLE public.job_execution_leases (
  job_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  lease_token UUID NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT fk_job_execution_leases_job
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_job_execution_lease_expiry
    CHECK (expires_at > acquired_at)
);

ALTER TABLE public.job_execution_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_execution_leases FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.claim_job_execution(
  p_job_id UUID,
  p_worker_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 60
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_workspace_id UUID;
  v_status public.job_status_enum;
  v_existing_token UUID;
  v_existing_worker TEXT;
  v_existing_expires TIMESTAMPTZ;
  v_token UUID;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 10 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'lease ttl must be between 10 and 300 seconds' USING ERRCODE = '22023';
  END IF;

  SELECT workspace_id INTO v_workspace_id
  FROM public.jobs
  WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM public.workspaces
  WHERE id = v_workspace_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  SELECT status INTO v_status
  FROM public.jobs
  WHERE id = p_job_id
    AND workspace_id = v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Terminal job cannot be claimed' USING ERRCODE = '22023';
  END IF;

  SELECT lease_token, worker_id, expires_at
    INTO v_existing_token, v_existing_worker, v_existing_expires
  FROM public.job_execution_leases
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_expires > now() THEN
      IF v_existing_worker = p_worker_id THEN
        UPDATE public.job_execution_leases
        SET heartbeat_at = now(),
            expires_at = now() + make_interval(secs => p_ttl_seconds)
        WHERE job_id = p_job_id;
        RETURN v_existing_token;
      END IF;

      RAISE EXCEPTION 'Job execution already claimed by another worker'
        USING ERRCODE = '55P03';
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.job_execution_leases
    SET lease_token = v_token,
        worker_id = p_worker_id,
        generation = generation + 1,
        acquired_at = now(),
        heartbeat_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds)
    WHERE job_id = p_job_id;
    RETURN v_token;
  END IF;

  v_token := gen_random_uuid();
  INSERT INTO public.job_execution_leases (
    job_id, workspace_id, lease_token, worker_id, expires_at
  ) VALUES (
    p_job_id, v_workspace_id, v_token, p_worker_id,
    now() + make_interval(secs => p_ttl_seconds)
  );

  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION private.renew_job_execution_lease(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID,
  p_ttl_seconds INTEGER DEFAULT 60
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_ttl_seconds < 10 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'lease ttl must be between 10 and 300 seconds' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_expires
  FROM public.job_execution_leases l
  JOIN public.workspaces w ON w.id = l.workspace_id
  JOIN public.jobs j ON j.id = l.job_id AND j.workspace_id = l.workspace_id
  WHERE l.job_id = p_job_id
    AND l.worker_id = p_worker_id
    AND l.lease_token = p_lease_token
    AND l.expires_at > now()
    AND w.deleted_at IS NULL
    AND j.status NOT IN ('completed', 'failed', 'cancelled')
  FOR UPDATE OF l;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution lease is missing, expired, or fenced'
      USING ERRCODE = '55P03';
  END IF;

  UPDATE public.job_execution_leases
  SET heartbeat_at = now(),
      expires_at = now() + make_interval(secs => p_ttl_seconds)
  WHERE job_id = p_job_id
  RETURNING expires_at INTO v_expires;

  RETURN v_expires;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_job_execution_lease(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
  FROM public.job_execution_leases l
  JOIN public.workspaces w ON w.id = l.workspace_id
  JOIN public.jobs j ON j.id = l.job_id AND j.workspace_id = l.workspace_id
  WHERE l.job_id = p_job_id
    AND l.worker_id = p_worker_id
    AND l.lease_token = p_lease_token
    AND l.expires_at > now()
    AND w.deleted_at IS NULL
    AND j.status NOT IN ('completed', 'failed', 'cancelled');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution lease is missing, expired, or fenced'
      USING ERRCODE = '55P03';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.release_job_execution_lease(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.job_execution_leases
  WHERE job_id = p_job_id
    AND worker_id = p_worker_id
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION private.claim_job_execution(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.renew_job_execution_lease(UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_job_execution_lease(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.release_job_execution_lease(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.claim_job_execution(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION private.renew_job_execution_lease(UUID, TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION private.assert_job_execution_lease(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION private.release_job_execution_lease(UUID, TEXT, UUID) TO service_role;

COMMIT;
