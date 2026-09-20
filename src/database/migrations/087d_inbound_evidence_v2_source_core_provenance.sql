-- Migration 087D: source-core authority for Natural Shadow evidence.
-- No backfill: historical manifests remain ineligible when freshness is NULL.

ALTER TABLE public.inbound_population_manifests
  ADD COLUMN IF NOT EXISTS source_freshness TIMESTAMPTZ NULL;

CREATE OR REPLACE FUNCTION public.persist_inbound_evidence_v2_natural_shadow_bundle(p_bundle JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_checkpoint_at_utc TIMESTAMPTZ;
  v_checkpoint_at_local TEXT;
  v_trigger_source TEXT;
  v_sync_run_id UUID;
  v_source_freshness TIMESTAMPTZ;
  v_manifest RECORD;
  v_existing RECORD;
  v_parent_id UUID;
  v_warehouses JSONB;
  v_count INTEGER;
  v_distinct INTEGER;
  v_valid INTEGER;
BEGIN
  IF p_bundle IS NULL OR jsonb_typeof(p_bundle) <> 'object' THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_INVALID_BUNDLE';
  END IF;
  v_warehouses := p_bundle->'warehouses';
  IF jsonb_typeof(v_warehouses) <> 'array' OR jsonb_array_length(v_warehouses) <> 3 THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_EXACTLY_THREE_WAREHOUSES_REQUIRED';
  END IF;
  v_checkpoint_at_utc := (p_bundle->>'checkpoint_at_utc')::TIMESTAMPTZ;
  v_checkpoint_at_local := p_bundle->>'checkpoint_at_local';
  v_trigger_source := NULLIF(btrim(p_bundle->>'trigger_source'), '');
  v_sync_run_id := (p_bundle->>'authoritative_sync_run_id')::UUID;
  v_source_freshness := (p_bundle->>'source_freshness')::TIMESTAMPTZ;
  IF v_trigger_source <> 'opspilot-followup-cycle'
     OR v_checkpoint_at_local IS NULL
     OR v_source_freshness IS NULL
     OR p_bundle->>'timezone' <> 'Asia/Ho_Chi_Minh'
     OR p_bundle->>'evidence_type' <> 'INBOUND_EVIDENCE_V2_NATURAL_SHADOW'
     OR p_bundle->>'observation_type' <> 'NATURAL'
     OR COALESCE((p_bundle->>'v2_telegram_sent')::BOOLEAN, TRUE)
     OR COALESCE((p_bundle->>'production_flow_changed')::BOOLEAN, TRUE)
     OR COALESCE((p_bundle->>'expected_warehouse_count')::INTEGER, -1) <> 3
     OR COALESCE((p_bundle->>'persisted_warehouse_count')::INTEGER, -1) <> 3
     OR p_bundle->>'shadow_status' <> 'COMPLETE' THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_INVALID_NATURAL_INVARIANTS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('INBOUND_EVIDENCE_V2_NATURAL_SHADOW|%s|%s', v_checkpoint_at_utc, v_trigger_source), 0));

  -- The exact scheduler checkpoint/run association replaces full-workflow success.
  PERFORM 1 FROM public.sync_runs sr
   WHERE sr.id = v_sync_run_id AND sr.checkpoint_at = v_checkpoint_at_utc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_AUTHORITATIVE_SYNC_RUN_INVALID';
  END IF;
  SELECT m.* INTO v_manifest
    FROM public.inbound_population_manifests m
   WHERE m.sync_run_id = v_sync_run_id AND m.source_system = 'RILLNET';
  IF NOT FOUND
     OR v_manifest.population_status <> 'COMPLETE'
     OR v_manifest.population_completed_at IS NULL
     OR v_manifest.source_freshness IS NULL
     OR v_manifest.source_freshness > v_checkpoint_at_utc
     OR v_manifest.expected_observation_count <> v_manifest.persisted_observation_count
     OR v_manifest.duplicate_conflict_count <> 0 THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID';
  END IF;
  IF v_source_freshness <> v_manifest.source_freshness
     OR COALESCE((p_bundle->>'expected_population_count')::INTEGER, -1) <> v_manifest.expected_observation_count
     OR COALESCE((p_bundle->>'persisted_population_count')::INTEGER, -1) <> v_manifest.persisted_observation_count
     OR COALESCE((p_bundle->>'conflict_count')::INTEGER, -1) <> v_manifest.duplicate_conflict_count THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_PROVENANCE_COUNT_MISMATCH';
  END IF;
  SELECT count(*), count(DISTINCT w.warehouse_id),
         count(*) FILTER (WHERE w.warehouse_id IN ('21161000','21158000','21160000'))
    INTO v_count, v_distinct, v_valid
    FROM jsonb_to_recordset(v_warehouses) AS w(warehouse_id TEXT);
  IF v_count <> 3 OR v_distinct <> 3 OR v_valid <> 3 THEN
    RAISE EXCEPTION 'INBOUND_EVIDENCE_V2_INVALID_PILOT_WAREHOUSE_SET';
  END IF;
  SELECT c.* INTO v_existing FROM public.inbound_evidence_v2_natural_shadow_checkpoints c
   WHERE c.evidence_type = 'INBOUND_EVIDENCE_V2_NATURAL_SHADOW'
     AND c.checkpoint_at_utc = v_checkpoint_at_utc AND c.trigger_source = v_trigger_source;
  IF FOUND THEN
    SELECT count(*), count(DISTINCT w.warehouse_id),
           count(*) FILTER (WHERE w.warehouse_id IN ('21161000','21158000','21160000'))
      INTO v_count, v_distinct, v_valid
      FROM public.inbound_evidence_v2_natural_shadow_warehouses w WHERE w.checkpoint_id = v_existing.id;
    IF v_existing.shadow_status <> 'COMPLETE' OR v_existing.observation_type <> 'NATURAL'
       OR v_existing.v2_telegram_sent OR v_existing.production_flow_changed
       OR v_existing.expected_warehouse_count <> 3 OR v_existing.persisted_warehouse_count <> 3
       OR v_count <> 3 OR v_distinct <> 3 OR v_valid <> 3 THEN
      RAISE EXCEPTION 'EXISTING_EVIDENCE_INCONSISTENT';
    END IF;
    RETURN jsonb_build_object('status', 'ALREADY_OBSERVED', 'checkpoint_id', v_existing.id);
  END IF;
  INSERT INTO public.inbound_evidence_v2_natural_shadow_checkpoints (
    evidence_type, observation_type, checkpoint_at_utc, checkpoint_at_local, timezone, trigger_source,
    authoritative_sync_run_id, manifest_status, expected_population_count, persisted_population_count,
    conflict_count, source_freshness, shadow_status, expected_warehouse_count, persisted_warehouse_count,
    v2_telegram_sent, production_flow_changed
  ) VALUES (
    'INBOUND_EVIDENCE_V2_NATURAL_SHADOW', 'NATURAL', v_checkpoint_at_utc, v_checkpoint_at_local,
    'Asia/Ho_Chi_Minh', v_trigger_source, v_sync_run_id, 'COMPLETE',
    v_manifest.expected_observation_count, v_manifest.persisted_observation_count,
    v_manifest.duplicate_conflict_count, v_manifest.source_freshness, 'COMPLETE', 3, 3, FALSE, FALSE
  ) RETURNING id INTO v_parent_id;
  INSERT INTO public.inbound_evidence_v2_natural_shadow_warehouses (
    checkpoint_id, warehouse_id, warehouse_name, backlog_orders, pipeline_orders, pipeline_known_kg,
    pipeline_unknown_weight_orders, picked_not_transferred_orders, in_transfer_orders, arrival_confirmed_orders,
    eta_known_orders, eta_unknown_orders, arrival_within_horizon_status, arrival_within_horizon_orders,
    pipeline_pressure, near_term_arrival_risk, routing_chat_id, routing_topic_id, source_freshness,
    shadow_message_text, shadow_message_generated
  ) SELECT v_parent_id, w.warehouse_id, w.warehouse_name, w.backlog_orders, w.pipeline_orders,
    w.pipeline_known_kg, w.pipeline_unknown_weight_orders, w.picked_not_transferred_orders,
    w.in_transfer_orders, w.arrival_confirmed_orders, w.eta_known_orders, w.eta_unknown_orders,
    w.arrival_within_horizon_status, w.arrival_within_horizon_orders, w.pipeline_pressure,
    w.near_term_arrival_risk, w.routing_chat_id, w.routing_topic_id, w.source_freshness,
    w.shadow_message_text, TRUE
    FROM jsonb_to_recordset(v_warehouses) AS w(
      warehouse_id TEXT, warehouse_name TEXT, backlog_orders INTEGER, pipeline_orders INTEGER,
      pipeline_known_kg NUMERIC, pipeline_unknown_weight_orders INTEGER, picked_not_transferred_orders INTEGER,
      in_transfer_orders INTEGER, arrival_confirmed_orders INTEGER, eta_known_orders INTEGER,
      eta_unknown_orders INTEGER, arrival_within_horizon_status TEXT, arrival_within_horizon_orders INTEGER,
      pipeline_pressure TEXT, near_term_arrival_risk TEXT, routing_chat_id TEXT, routing_topic_id TEXT,
      source_freshness TIMESTAMPTZ, shadow_message_text TEXT, shadow_message_generated BOOLEAN);
  RETURN jsonb_build_object('status', 'OBSERVED', 'checkpoint_id', v_parent_id);
END;
$function$;

ALTER FUNCTION public.persist_inbound_evidence_v2_natural_shadow_bundle(JSONB) OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION public.persist_inbound_evidence_v2_natural_shadow_bundle(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.persist_inbound_evidence_v2_natural_shadow_bundle(JSONB) TO service_role;
