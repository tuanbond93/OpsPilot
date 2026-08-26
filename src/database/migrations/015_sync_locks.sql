-- Migration 015: Create sync_locks table and atomic lock acquisition functions

CREATE TABLE IF NOT EXISTS public.sync_locks (
  lock_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for expiration cleanup and queries
CREATE INDEX IF NOT EXISTS idx_sync_locks_expires_at ON public.sync_locks(expires_at);

-- Atomic acquisition function
CREATE OR REPLACE FUNCTION public.acquire_sync_lock(
  p_lock_key TEXT,
  p_owner_id TEXT,
  p_ttl_ms INT
)
RETURNS TABLE (
  acquired BOOLEAN,
  owner_id TEXT,
  lock_key TEXT,
  expired_takeover BOOLEAN,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_new_expires TIMESTAMPTZ := v_now + (p_ttl_ms || ' milliseconds')::INTERVAL;
  v_existing RECORD;
BEGIN
  SELECT * INTO v_existing FROM public.sync_locks WHERE sync_locks.lock_key = p_lock_key FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.sync_locks (lock_key, owner_id, acquired_at, expires_at, heartbeat_at)
    VALUES (p_lock_key, p_owner_id, v_now, v_new_expires, v_now);

    RETURN QUERY SELECT TRUE, p_owner_id, p_lock_key, FALSE, v_new_expires;
    RETURN;
  END IF;

  IF v_existing.expires_at < v_now THEN
    UPDATE public.sync_locks
    SET owner_id = p_owner_id,
        acquired_at = v_now,
        expires_at = v_new_expires,
        heartbeat_at = v_now
    WHERE sync_locks.lock_key = p_lock_key;

    RETURN QUERY SELECT TRUE, p_owner_id, p_lock_key, TRUE, v_new_expires;
    RETURN;
  END IF;

  RETURN QUERY SELECT FALSE, v_existing.owner_id, p_lock_key, FALSE, v_existing.expires_at;
  RETURN;
END;
$$;

-- Atomic renew function
CREATE OR REPLACE FUNCTION public.renew_sync_lock(
  p_lock_key TEXT,
  p_owner_id TEXT,
  p_ttl_ms INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_new_expires TIMESTAMPTZ := v_now + (p_ttl_ms || ' milliseconds')::INTERVAL;
  v_count INT;
BEGIN
  UPDATE public.sync_locks
  SET expires_at = v_new_expires,
      heartbeat_at = v_now
  WHERE lock_key = p_lock_key
    AND owner_id = p_owner_id
    AND expires_at >= v_now;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- Atomic release function
CREATE OR REPLACE FUNCTION public.release_sync_lock(
  p_lock_key TEXT,
  p_owner_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.sync_locks
  WHERE lock_key = p_lock_key
    AND owner_id = p_owner_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
