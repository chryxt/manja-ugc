-- ============================================================================
-- 10_job_rpc_part_5.sql
-- Domain: Job Retry, Lineage Expansion, and Fresh Reservation
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. PHYSICAL INVARIANT: Strict Linear Lineage
-- ============================================================================
-- A failed/cancelled job can have at most one direct retry child.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_single_retry_child
ON public.jobs(parent_job_id)
WHERE parent_job_id IS NOT NULL;

-- ============================================================================
-- 2. PRIMITIVE: retry_job
-- ============================================================================
CREATE OR REPLACE FUNCTION private.retry_job(
    p_failed_job_id UUID,
    p_actor_user_id UUID,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_workspace_id UUID;
    v_actor_role public.workspace_role;

    v_old_status public.job_status_enum;
    v_old_job_type TEXT;
    v_old_root_job_id UUID;
    v_old_attempt_number INTEGER;

    v_old_reservation_id UUID;
    v_old_reservation_status TEXT;

    v_existing_retry_id UUID;
    v_existing_retry_key TEXT;
    v_existing_retry_job_type TEXT;

    v_any_existing_id UUID;
    v_any_existing_parent UUID;
    v_any_existing_job_type TEXT;

    v_new_job_id UUID;
    v_new_reservation_id UUID;
    v_cost_snapshot INTEGER;
    v_pricing_version TEXT;

    v_balance INTEGER;
    v_reserved INTEGER;
BEGIN
    -- 1. Actor Mandatory Check
    IF p_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Actor user is required for retry'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Discovery: source workspace lookup only. This is intentionally unlocked.
    SELECT workspace_id
    INTO v_workspace_id
    FROM public.jobs
    WHERE id = p_failed_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source job not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- 3. LOCK ORDER #1: Workspace serialization point.
    PERFORM 1
    FROM public.workspaces
    WHERE id = v_workspace_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace not found or inactive'
            USING ERRCODE = 'P0002';
    END IF;

    -- 4. Revalidate actor membership after obtaining workspace lock.
    SELECT wm.role
    INTO v_actor_role
    FROM public.workspace_members wm
    WHERE wm.workspace_id = v_workspace_id
      AND wm.user_id = p_actor_user_id;

    IF v_actor_role IS NULL THEN
        RAISE EXCEPTION 'Actor is not an active workspace member'
            USING ERRCODE = '42501';
    END IF;

    -- 5. LOCK ORDER #2: Source job.
    SELECT status, job_type, root_job_id, attempt_number
    INTO v_old_status, v_old_job_type, v_old_root_job_id, v_old_attempt_number
    FROM public.jobs
    WHERE id = p_failed_job_id
      AND workspace_id = v_workspace_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source job disappeared or changed workspace'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_old_status NOT IN ('failed', 'cancelled') THEN
        RAISE EXCEPTION 'Only failed or cancelled jobs can be retried'
            USING ERRCODE = '22023';
    END IF;

    -- 6. LOCK ORDER #3: Source reservation.
    SELECT id, status
    INTO v_old_reservation_id, v_old_reservation_status
    FROM public.credit_reservations
    WHERE job_id = p_failed_job_id
      AND workspace_id = v_workspace_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Financial invariant violated: source reservation missing'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_old_reservation_status <> 'RELEASED' THEN
        RAISE EXCEPTION
            'Source job reservation must be RELEASED before retry (Current: %)',
            v_old_reservation_status
            USING ERRCODE = '22023';
    END IF;

    -- 7. Existing direct retry child check.
    -- Source job lock serializes concurrent retries of the same parent.
    SELECT id, idempotency_key, job_type
    INTO v_existing_retry_id, v_existing_retry_key, v_existing_retry_job_type
    FROM public.jobs
    WHERE parent_job_id = p_failed_job_id;

    IF v_existing_retry_id IS NOT NULL THEN
        IF p_idempotency_key IS NOT NULL
           AND v_existing_retry_key = p_idempotency_key
           AND v_existing_retry_job_type = v_old_job_type THEN
            RETURN v_existing_retry_id;
        END IF;

        RAISE EXCEPTION 'Source job has already been retried with a different identity'
            USING ERRCODE = '22023';
    END IF;

    -- 8. LOCK ORDER #4: Credit account.
    SELECT balance, reserved_credits
    INTO v_balance, v_reserved
    FROM public.credit_accounts
    WHERE workspace_id = v_workspace_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Credit account not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- 9. Idempotency slow-path.
    -- A matching key is only idempotent when it is the same retry lineage and job type.
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id, parent_job_id, job_type
        INTO v_any_existing_id, v_any_existing_parent, v_any_existing_job_type
        FROM public.jobs
        WHERE workspace_id = v_workspace_id
          AND idempotency_key = p_idempotency_key;

        IF v_any_existing_id IS NOT NULL THEN
            IF v_any_existing_parent = p_failed_job_id
               AND v_any_existing_job_type = v_old_job_type THEN
                RETURN v_any_existing_id;
            END IF;

            RAISE EXCEPTION 'Idempotency conflict: key belongs to a different retry identity'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 10. Retry uses CURRENT pricing, not the source job's historical snapshot.
    SELECT cost_snapshot, pricing_version
    INTO v_cost_snapshot, v_pricing_version
    FROM private.get_job_price(v_old_job_type);

    -- 11. Available balance = balance - currently reserved credits.
    IF (v_balance - v_reserved) < v_cost_snapshot THEN
        RAISE EXCEPTION 'Insufficient available credits for retry'
            USING ERRCODE = 'P0001';
    END IF;

    -- 12. Fresh job row. Retry never revives the source job.
    INSERT INTO public.jobs (
        workspace_id,
        job_type,
        status,
        cost_snapshot,
        pricing_version,
        idempotency_key,
        created_by,
        parent_job_id,
        root_job_id,
        attempt_number
    )
    VALUES (
        v_workspace_id,
        v_old_job_type,
        'queued',
        v_cost_snapshot,
        v_pricing_version,
        p_idempotency_key,
        p_actor_user_id,
        p_failed_job_id,
        COALESCE(v_old_root_job_id, p_failed_job_id),
        v_old_attempt_number + 1
    )
    RETURNING id INTO v_new_job_id;

    -- 13. Fresh financial reservation for the new attempt.
    INSERT INTO public.credit_reservations (
        workspace_id,
        job_id,
        amount,
        status
    )
    VALUES (
        v_workspace_id,
        v_new_job_id,
        v_cost_snapshot,
        'RESERVED'
    )
    RETURNING id INTO v_new_reservation_id;

    -- 14. Reflect the new hold on the account snapshot.
    UPDATE public.credit_accounts
    SET reserved_credits = reserved_credits + v_cost_snapshot
    WHERE workspace_id = v_workspace_id;

    -- 15. Append audit event.
    INSERT INTO public.audit_logs (
        workspace_id,
        actor_user_id,
        action,
        target_type,
        target_id,
        metadata
    )
    VALUES (
        v_workspace_id,
        p_actor_user_id,
        'JOB_RETRIED',
        'JOB',
        v_new_job_id,
        jsonb_build_object(
            'old_job_id', p_failed_job_id,
            'job_type', v_old_job_type,
            'new_attempt', v_old_attempt_number + 1,
            'cost', v_cost_snapshot,
            'reservation_id', v_new_reservation_id
        )
    );

    RETURN v_new_job_id;
END;
$$;

REVOKE ALL
ON FUNCTION private.retry_job(UUID, UUID, TEXT)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION private.retry_job(UUID, UUID, TEXT)
TO service_role;

COMMIT;
