BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TYPE public.workspace_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.job_status_enum AS ENUM (
  'queued', 'processing', 'waiting_provider', 'rendering',
  'completed', 'failed', 'cancelled'
);
CREATE TYPE public.reservation_status_enum AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');
CREATE TYPE public.transaction_type_enum AS ENUM ('TOPUP', 'JOB_DEDUCT', 'REFUND', 'MANUAL_ADJUST');

CREATE TABLE public.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE public.workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.workspace_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.product_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  product_id UUID NOT NULL,
  asset_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT fk_product_assets_product
    FOREIGN KEY (product_id, workspace_id)
    REFERENCES public.products(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.storyboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  product_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT fk_storyboards_product
    FOREIGN KEY (product_id, workspace_id)
    REFERENCES public.products(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL,
  status public.job_status_enum NOT NULL DEFAULT 'queued',
  progress SMALLINT NOT NULL DEFAULT 0,
  cost_snapshot INTEGER NOT NULL,
  pricing_version TEXT NOT NULL,
  parent_job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT jobs_cost_check CHECK (cost_snapshot >= 0)
);

CREATE TABLE public.video_jobs (
  job_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  storyboard_id UUID,
  render_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_video_jobs_job
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_video_jobs_storyboard
    FOREIGN KEY (storyboard_id, workspace_id)
    REFERENCES public.storyboards(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.credit_accounts (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  balance INTEGER NOT NULL DEFAULT 0,
  reserved_credits INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_accounts_balance_check CHECK (balance >= 0),
  CONSTRAINT credit_accounts_reserved_check CHECK (reserved_credits >= 0),
  CONSTRAINT credit_accounts_available_check CHECK (reserved_credits <= balance)
);

CREATE TABLE public.credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL,
  amount INTEGER NOT NULL,
  status public.reservation_status_enum NOT NULL DEFAULT 'RESERVED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  UNIQUE (id, workspace_id),
  UNIQUE (job_id),
  CONSTRAINT credit_reservations_amount_check CHECK (amount > 0)
);

CREATE TABLE public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  reservation_id UUID,
  job_id UUID,
  transaction_type public.transaction_type_enum NOT NULL,
  amount INTEGER NOT NULL,
  balance_delta INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT credit_transactions_amount_check CHECK (amount > 0)
);

CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
