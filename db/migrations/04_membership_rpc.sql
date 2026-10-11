BEGIN;

CREATE OR REPLACE FUNCTION private.create_new_workspace(p_workspace_name TEXT, p_slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_workspace UUID;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF length(trim(p_workspace_name)) < 2 OR length(trim(p_workspace_name)) > 255 THEN
    RAISE EXCEPTION 'Invalid workspace name' USING ERRCODE='22023';
  END IF;
  IF p_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Invalid workspace slug' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.workspaces(name, slug) VALUES (trim(p_workspace_name), p_slug)
  RETURNING id INTO v_workspace;
  INSERT INTO public.workspace_members(workspace_id, user_id, role)
  VALUES (v_workspace, v_actor, 'owner');
  INSERT INTO public.credit_accounts(workspace_id, balance, reserved_credits)
  VALUES (v_workspace, 0, 0);
  INSERT INTO public.audit_logs(workspace_id, actor_user_id, action, target_type, target_id)
  VALUES (v_workspace, v_actor, 'WORKSPACE_CREATED', 'WORKSPACE', v_workspace);
  RETURN v_workspace;
END;
$$;

CREATE OR REPLACE FUNCTION private.invite_member(
  p_workspace_id UUID, p_user_id UUID, p_role public.workspace_role DEFAULT 'member'
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_actor UUID := auth.uid(); v_actor_role public.workspace_role; v_member UUID;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_role = 'owner' THEN RAISE EXCEPTION 'Owner must be assigned by transfer' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=v_actor;
  IF v_actor_role='owner' THEN NULL;
  ELSIF v_actor_role='admin' AND p_role='member' THEN NULL;
  ELSE RAISE EXCEPTION 'Insufficient privileges' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user not found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.workspace_members(workspace_id,user_id,role)
  VALUES(p_workspace_id,p_user_id,p_role) RETURNING id INTO v_member;
  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(p_workspace_id,v_actor,'MEMBER_ADDED','WORKSPACE_MEMBER',v_member,jsonb_build_object('role',p_role));
  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION private.change_member_role(
  p_workspace_id UUID, p_target_user_id UUID, p_new_role public.workspace_role
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_actor UUID := auth.uid(); v_actor_role public.workspace_role; v_target_role public.workspace_role; v_member_id UUID;
BEGIN
  IF p_new_role='owner' THEN RAISE EXCEPTION 'Use ownership transfer' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Only owner can change roles' USING ERRCODE='42501'; END IF;
  SELECT id,role INTO v_member_id,v_target_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
  IF v_target_role='owner' THEN RAISE EXCEPTION 'Owner role is immutable here' USING ERRCODE='22023'; END IF;
  UPDATE public.workspace_members SET role=p_new_role,updated_at=now() WHERE id=v_member_id;
  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(p_workspace_id,v_actor,'MEMBER_ROLE_CHANGED','WORKSPACE_MEMBER',v_member_id,jsonb_build_object('new_role',p_new_role));
END;
$$;

CREATE OR REPLACE FUNCTION private.remove_member(p_workspace_id UUID, p_target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_actor UUID := auth.uid(); v_actor_role public.workspace_role; v_target_role public.workspace_role; v_member_id UUID;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=v_actor;
  SELECT id,role INTO v_member_id,v_target_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
  IF v_target_role='owner' THEN RAISE EXCEPTION 'Owner cannot be removed' USING ERRCODE='22023'; END IF;
  IF NOT (v_actor_role='owner' OR (v_actor_role='admin' AND v_target_role='member')) THEN
    RAISE EXCEPTION 'Insufficient privileges' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(p_workspace_id,v_actor,'MEMBER_REMOVED','WORKSPACE_MEMBER',v_member_id,jsonb_build_object('role',v_target_role));
  DELETE FROM public.workspace_members WHERE id=v_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.transfer_workspace_ownership(
  p_workspace_id UUID, p_new_owner_user_id UUID, p_previous_owner_new_role public.workspace_role DEFAULT 'admin'
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_actor UUID := auth.uid(); v_actor_role public.workspace_role; v_target_id UUID;
BEGIN
  IF p_previous_owner_new_role='owner' THEN RAISE EXCEPTION 'Previous owner must be demoted' USING ERRCODE='22023'; END IF;
  IF p_new_owner_user_id=v_actor THEN RAISE EXCEPTION 'Target must differ from actor' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found or inactive' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Only current owner can transfer ownership' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_target_id FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_new_owner_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'New owner must already be a member' USING ERRCODE='P0002'; END IF;
  UPDATE public.workspace_members SET role='owner',updated_at=now() WHERE id=v_target_id;
  UPDATE public.workspace_members SET role=p_previous_owner_new_role,updated_at=now()
  WHERE workspace_id=p_workspace_id AND user_id=v_actor;
  IF (SELECT count(*) FROM public.workspace_members WHERE workspace_id=p_workspace_id AND role='owner') <> 1 THEN
    RAISE EXCEPTION 'Ownership invariant violated';
  END IF;
  INSERT INTO public.audit_logs(workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(p_workspace_id,v_actor,'OWNERSHIP_TRANSFERRED','WORKSPACE',p_workspace_id,
    jsonb_build_object('new_owner_user_id',p_new_owner_user_id,'previous_owner_new_role',p_previous_owner_new_role));
END;
$$;

REVOKE ALL ON FUNCTION private.create_new_workspace(TEXT,TEXT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.invite_member(UUID,UUID,public.workspace_role) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.change_member_role(UUID,UUID,public.workspace_role) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.remove_member(UUID,UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.transfer_workspace_ownership(UUID,UUID,public.workspace_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.create_new_workspace(TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.invite_member(UUID,UUID,public.workspace_role) TO authenticated;
GRANT EXECUTE ON FUNCTION private.change_member_role(UUID,UUID,public.workspace_role) TO authenticated;
GRANT EXECUTE ON FUNCTION private.remove_member(UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.transfer_workspace_ownership(UUID,UUID,public.workspace_role) TO authenticated;

COMMIT;
