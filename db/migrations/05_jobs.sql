BEGIN;

CREATE TYPE public.job_operation_status AS ENUM ('created','submitted','in_progress','succeeded','failed','cancelled');
CREATE TYPE public.ai_provider AS ENUM ('openai','gemini','replicate','ffmpeg','internal');

ALTER TABLE public.jobs
  ADD COLUMN current_step TEXT,
  ADD COLUMN root_job_id UUID,
  ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN error_code TEXT,
  ADD COLUMN error_message TEXT,
  ADD CONSTRAINT jobs_attempt_check CHECK (attempt_number >= 1),
  ADD CONSTRAINT jobs_root_not_self_check CHECK (root_job_id IS NULL OR root_job_id <> id),
  ADD CONSTRAINT fk_jobs_root
    FOREIGN KEY (root_job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_jobs_idempotency
ON public.jobs(workspace_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.job_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  job_id UUID NOT NULL,
  provider public.ai_provider NOT NULL,
  operation_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  provider_operation_id TEXT,
  status public.job_operation_status NOT NULL DEFAULT 'created',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  request_metadata JSONB,
  response_metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_job_ops_parent
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT uq_job_operations_execution UNIQUE (job_id, operation_key, attempt_number),
  CONSTRAINT job_operations_attempt_check CHECK (attempt_number >= 1),
  CONSTRAINT job_operations_start_check CHECK (
    (status='created' AND started_at IS NULL)
    OR (status<>'created' AND started_at IS NOT NULL)
  ),
  CONSTRAINT job_operations_completion_check CHECK (
    (status IN ('succeeded','failed','cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('created','submitted','in_progress') AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_job_operations_provider_operation
ON public.job_operations(provider, provider_operation_id)
WHERE provider_operation_id IS NOT NULL;

ALTER TABLE public.job_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.job_operations TO authenticated;
CREATE POLICY job_operations_select ON public.job_operations
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));

COMMIT;
