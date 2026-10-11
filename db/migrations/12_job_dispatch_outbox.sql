BEGIN;

CREATE TYPE public.outbox_status_enum AS ENUM ('pending','processing','completed','failed');

CREATE TABLE public.job_dispatch_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  queue_name TEXT NOT NULL DEFAULT 'ugc-jobs',
  payload JSONB NOT NULL,
  status public.outbox_status_enum NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token UUID,
  claimed_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT fk_job_dispatch_outbox_job FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT uq_job_dispatch_outbox_job UNIQUE(job_id),
  CONSTRAINT chk_job_dispatch_outbox_payload CHECK (payload ? 'jobId'),
  CONSTRAINT chk_job_dispatch_outbox_lease CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND claim_token IS NULL AND claimed_by IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_job_dispatch_outbox_completed CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR
    (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX idx_job_dispatch_outbox_ready
  ON public.job_dispatch_outbox(available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_job_dispatch_outbox_processing_expiry
  ON public.job_dispatch_outbox(lease_expires_at)
  WHERE status = 'processing';

ALTER TABLE public.job_dispatch_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_dispatch_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.job_dispatch_outbox TO service_role;

CREATE OR REPLACE FUNCTION private.trg_enqueue_job_to_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'queued' THEN
    INSERT INTO public.job_dispatch_outbox(job_id, workspace_id, queue_name, payload)
    VALUES (
      NEW.id,
      NEW.workspace_id,
      'ugc-jobs',
      pg_catalog.jsonb_build_object('jobId', NEW.id)
    )
    ON CONFLICT (job_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.trg_enqueue_job_to_outbox() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_jobs_insert_outbox ON public.jobs;
CREATE TRIGGER trg_jobs_insert_outbox
AFTER INSERT ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION private.trg_enqueue_job_to_outbox();

CREATE OR REPLACE FUNCTION private.claim_outbox_messages(
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
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_dispatcher_id IS NULL OR pg_catalog.btrim(p_dispatcher_id) = '' THEN
    RAISE EXCEPTION 'dispatcher id required' USING ERRCODE = '22023';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'batch size out of range' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds < 5 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'lease seconds out of range' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT o.id
    FROM public.job_dispatch_outbox o
    WHERE (
      (o.status = 'pending' AND o.available_at <= pg_catalog.now())
      OR
      (o.status = 'processing' AND o.lease_expires_at < pg_catalog.now())
    )
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.job_dispatch_outbox o
     SET status = 'processing',
         attempt_count = o.attempt_count + 1,
         claim_token = pg_catalog.gen_random_uuid(),
         claimed_by = p_dispatcher_id,
         lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
         last_error = CASE WHEN o.status = 'processing' THEN 'stale dispatch lease recovered' ELSE o.last_error END,
         updated_at = pg_catalog.now()
    FROM eligible e
   WHERE o.id = e.id
  RETURNING o.id, o.job_id, o.queue_name, o.payload, o.claim_token, o.lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION private.complete_outbox_message(
  p_outbox_id UUID,
  p_claim_token UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.job_dispatch_outbox
     SET status = 'completed',
         claim_token = NULL,
         claimed_by = NULL,
         lease_expires_at = NULL,
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = p_outbox_id
     AND status = 'processing'
     AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outbox claim lost' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.fail_outbox_message(
  p_outbox_id UUID,
  p_claim_token UUID,
  p_error_msg TEXT,
  p_retry_delay_seconds INTEGER DEFAULT 5,
  p_max_attempts INTEGER DEFAULT 10
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt_count INTEGER;
BEGIN
  IF p_retry_delay_seconds < 0 OR p_retry_delay_seconds > 3600 THEN
    RAISE EXCEPTION 'retry delay out of range' USING ERRCODE = '22023';
  END IF;
  IF p_max_attempts < 1 OR p_max_attempts > 1000 THEN
    RAISE EXCEPTION 'max attempts out of range' USING ERRCODE = '22023';
  END IF;

  SELECT attempt_count INTO v_attempt_count
  FROM public.job_dispatch_outbox
  WHERE id = p_outbox_id
    AND status = 'processing'
    AND claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outbox claim lost' USING ERRCODE = '55000';
  END IF;

  UPDATE public.job_dispatch_outbox
     SET status = CASE WHEN v_attempt_count >= p_max_attempts THEN 'failed' ELSE 'pending' END,
         claim_token = NULL,
         claimed_by = NULL,
         lease_expires_at = NULL,
         available_at = CASE WHEN v_attempt_count >= p_max_attempts
                             THEN available_at
                             ELSE pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_delay_seconds)
                        END,
         last_error = pg_catalog.left(COALESCE(p_error_msg, 'unknown dispatch error'), 4000),
         updated_at = pg_catalog.now()
   WHERE id = p_outbox_id;
END;
$$;

REVOKE ALL ON FUNCTION private.claim_outbox_messages(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.complete_outbox_message(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fail_outbox_message(UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.claim_outbox_messages(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION private.complete_outbox_message(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION private.fail_outbox_message(UUID, UUID, TEXT, INTEGER, INTEGER) TO service_role;

COMMIT;
