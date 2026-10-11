BEGIN;

-- Extend the domain tables created in 01_core.sql instead of recreating them.
ALTER TABLE public.products
  ADD COLUMN description TEXT,
  ADD COLUMN dna_profile JSONB,
  ADD COLUMN dna_source_job_id UUID;

ALTER TABLE public.products
  ADD CONSTRAINT fk_products_dna_source_job
  FOREIGN KEY (dna_source_job_id, workspace_id)
  REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE public.product_assets
  ADD COLUMN public_url TEXT,
  ADD COLUMN mime_type TEXT,
  ADD COLUMN size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0);

ALTER TABLE public.storyboards
  ADD COLUMN source_job_id UUID,
  ADD COLUMN script_content TEXT,
  ADD COLUMN visual_prompts JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft',
  ADD CONSTRAINT storyboards_status_check CHECK (status IN ('draft','approved','rejected','archived')),
  ADD CONSTRAINT fk_storyboards_source_job
    FOREIGN KEY (source_job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

CREATE TABLE public.job_domain_inputs (
  job_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  product_id UUID,
  storyboard_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_job_domain_inputs_job
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_domain_inputs_product
    FOREIGN KEY (product_id, workspace_id)
    REFERENCES public.products(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_domain_inputs_storyboard
    FOREIGN KEY (storyboard_id, workspace_id)
    REFERENCES public.storyboards(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT job_domain_inputs_has_subject CHECK (product_id IS NOT NULL OR storyboard_id IS NOT NULL)
);

CREATE TABLE public.generated_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  storyboard_id UUID NOT NULL,
  job_id UUID NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  provider_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (job_id, storage_key),
  CONSTRAINT fk_generated_videos_storyboard
    FOREIGN KEY (storyboard_id, workspace_id)
    REFERENCES public.storyboards(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_generated_videos_job
    FOREIGN KEY (job_id, workspace_id)
    REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT
);

ALTER TABLE public.job_domain_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_videos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.job_domain_inputs, public.generated_videos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_domain_inputs, public.generated_videos TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.job_domain_inputs, public.generated_videos TO service_role;

CREATE POLICY job_domain_inputs_select ON public.job_domain_inputs
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));

CREATE POLICY generated_videos_select ON public.generated_videos
FOR SELECT TO authenticated
USING (private.user_has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[]));

-- Atomic domain-aware job creation. The existing financial primitive remains authoritative;
-- this wrapper binds the new job to product/storyboard inputs before the transaction commits.
CREATE OR REPLACE FUNCTION private.create_domain_job_and_reserve_credits(
  p_workspace_id UUID,
  p_job_type TEXT,
  p_actor_user_id UUID,
  p_idempotency_key TEXT,
  p_product_id UUID DEFAULT NULL,
  p_storyboard_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job_id UUID;
  v_existing_product_id UUID;
  v_existing_storyboard_id UUID;
BEGIN
  IF p_product_id IS NULL AND p_storyboard_id IS NULL THEN
    RAISE EXCEPTION 'Domain job requires product or storyboard binding' USING ERRCODE='22023';
  END IF;

  IF p_job_type IN ('product_dna','catalog_image') AND p_product_id IS NULL THEN
    RAISE EXCEPTION 'Job type % requires product binding', p_job_type USING ERRCODE='22023';
  END IF;

  IF p_job_type = 'ugc_video' AND (p_product_id IS NULL OR p_storyboard_id IS NULL) THEN
    RAISE EXCEPTION 'ugc_video requires product and storyboard binding' USING ERRCODE='22023';
  END IF;

  IF p_product_id IS NOT NULL THEN
    PERFORM 1 FROM public.products
    WHERE id=p_product_id AND workspace_id=p_workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found in workspace' USING ERRCODE='P0002';
    END IF;
  END IF;

  IF p_storyboard_id IS NOT NULL THEN
    PERFORM 1 FROM public.storyboards
    WHERE id=p_storyboard_id AND workspace_id=p_workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Storyboard not found in workspace' USING ERRCODE='P0002';
    END IF;
  END IF;

  v_job_id := private.create_job_and_reserve_credits(
    p_workspace_id,
    p_job_type,
    p_actor_user_id,
    p_idempotency_key
  );

  INSERT INTO public.job_domain_inputs(job_id,workspace_id,product_id,storyboard_id)
  VALUES(v_job_id,p_workspace_id,p_product_id,p_storyboard_id)
  ON CONFLICT (job_id) DO NOTHING;

  SELECT product_id,storyboard_id
  INTO v_existing_product_id,v_existing_storyboard_id
  FROM public.job_domain_inputs
  WHERE job_id=v_job_id AND workspace_id=p_workspace_id;

  IF v_existing_product_id IS DISTINCT FROM p_product_id
     OR v_existing_storyboard_id IS DISTINCT FROM p_storyboard_id THEN
    RAISE EXCEPTION 'Idempotency key reused with different domain binding' USING ERRCODE='22023';
  END IF;

  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION private.create_domain_job_and_reserve_credits(UUID,TEXT,UUID,TEXT,UUID,UUID)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.create_domain_job_and_reserve_credits(UUID,TEXT,UUID,TEXT,UUID,UUID)
TO service_role;

COMMIT;
