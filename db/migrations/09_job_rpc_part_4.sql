BEGIN;

CREATE OR REPLACE FUNCTION private.finalize_job(
  p_job_id UUID,
  p_outcome public.job_status_enum,
  p_actor_user_id UUID,
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
  v_cost INTEGER;
  v_reservation_id UUID;
  v_reservation_status public.reservation_status_enum;
  v_reservation_amount INTEGER;
  v_balance INTEGER;
  v_reserved INTEGER;
BEGIN
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'Actor user is required' USING ERRCODE='22023'; END IF;
  IF p_outcome NOT IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'Outcome must be terminal' USING ERRCODE='22023';
  END IF;

  SELECT workspace_id,status,cost_snapshot
  INTO v_workspace_id,v_job_status,v_cost
  FROM public.jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE='P0002'; END IF;

  IF v_job_status IN ('completed','failed','cancelled') THEN
    IF v_job_status=p_outcome THEN RETURN; END IF;
    RAISE EXCEPTION 'Terminal outcome conflict: existing %, requested %',v_job_status,p_outcome USING ERRCODE='22023';
  END IF;

  IF NOT private.validate_job_transition(v_job_status,p_outcome) THEN
    RAISE EXCEPTION 'Invalid terminal transition from % to %',v_job_status,p_outcome USING ERRCODE='22023';
  END IF;

  SELECT id,status,amount
  INTO v_reservation_id,v_reservation_status,v_reservation_amount
  FROM public.credit_reservations
  WHERE job_id=p_job_id AND workspace_id=v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial invariant violated: reservation missing' USING ERRCODE='P0002';
  END IF;
  IF v_reservation_status<>'RESERVED' THEN
    RAISE EXCEPTION 'Financial invariant violated: reservation is %, expected RESERVED',v_reservation_status USING ERRCODE='22023';
  END IF;
  IF v_reservation_amount<>v_cost THEN
    RAISE EXCEPTION 'Financial invariant violated: reservation amount does not match job cost' USING ERRCODE='22023';
  END IF;

  SELECT balance,reserved_credits INTO v_balance,v_reserved
  FROM public.credit_accounts WHERE workspace_id=v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial invariant violated: credit account missing' USING ERRCODE='P0002';
  END IF;
  IF v_reserved<v_reservation_amount THEN
    RAISE EXCEPTION 'Financial invariant violated: insufficient reserved credits' USING ERRCODE='22023';
  END IF;

  IF p_outcome='completed' THEN
    IF v_balance<v_reservation_amount THEN
      RAISE EXCEPTION 'Financial invariant violated: balance below settlement amount' USING ERRCODE='22023';
    END IF;

    UPDATE public.credit_reservations
    SET status='SETTLED', finalized_at=now()
    WHERE id=v_reservation_id;

    UPDATE public.credit_accounts
    SET balance=balance-v_reservation_amount,
        reserved_credits=reserved_credits-v_reservation_amount,
        updated_at=now()
    WHERE workspace_id=v_workspace_id;

    INSERT INTO public.credit_transactions(
      workspace_id,reservation_id,job_id,transaction_type,amount,balance_delta
    ) VALUES (
      v_workspace_id,v_reservation_id,p_job_id,'JOB_DEDUCT',v_reservation_amount,-v_reservation_amount
    );
  ELSE
    UPDATE public.credit_reservations
    SET status='RELEASED', finalized_at=now()
    WHERE id=v_reservation_id;

    UPDATE public.credit_accounts
    SET reserved_credits=reserved_credits-v_reservation_amount,
        updated_at=now()
    WHERE workspace_id=v_workspace_id;
  END IF;

  UPDATE public.jobs
  SET status=p_outcome,
      progress=CASE WHEN p_outcome='completed' THEN 100 ELSE progress END,
      completed_at=CASE WHEN p_outcome='completed' THEN now() ELSE completed_at END,
      failed_at=CASE WHEN p_outcome='failed' THEN now() ELSE failed_at END,
      cancelled_at=CASE WHEN p_outcome='cancelled' THEN now() ELSE cancelled_at END,
      error_code=p_error_code,
      error_message=p_error_message,
      updated_at=now()
  WHERE id=p_job_id;

  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(
    v_workspace_id,p_actor_user_id,
    CASE p_outcome WHEN 'completed' THEN 'JOB_COMPLETED' WHEN 'failed' THEN 'JOB_FAILED' ELSE 'JOB_CANCELLED' END,
    'JOB',p_job_id,
    jsonb_build_object('outcome',p_outcome,'reservation_id',v_reservation_id,'amount',v_reservation_amount)
  );
END;
$$;

REVOKE ALL ON FUNCTION private.finalize_job(UUID,public.job_status_enum,UUID,TEXT,TEXT)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.finalize_job(UUID,public.job_status_enum,UUID,TEXT,TEXT)
TO service_role;

COMMIT;
