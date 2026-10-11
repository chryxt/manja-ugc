BEGIN;

ALTER TABLE public.jobs
  ADD CONSTRAINT fk_jobs_parent
  FOREIGN KEY (parent_job_id, workspace_id)
  REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

ALTER TABLE public.credit_reservations
  ADD CONSTRAINT fk_credit_reservations_job
  FOREIGN KEY (job_id, workspace_id)
  REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_reservation_lifecycle CHECK (
    (status = 'RESERVED' AND finalized_at IS NULL)
    OR
    (status IN ('SETTLED', 'RELEASED') AND finalized_at IS NOT NULL)
  );

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT fk_credit_transactions_reservation
  FOREIGN KEY (reservation_id, workspace_id)
  REFERENCES public.credit_reservations(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_credit_transactions_job
  FOREIGN KEY (job_id, workspace_id)
  REFERENCES public.jobs(id, workspace_id) ON DELETE RESTRICT;

COMMIT;
