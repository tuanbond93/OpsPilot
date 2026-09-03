-- Level C bridge: attach legacy follow-up Telegram evidence to the Decision
-- created for the same follow-up case. This migration records provenance only:
-- employee replies and Manager classifications never transition a Decision.

ALTER TABLE telegram_followup_reminders
  ADD COLUMN IF NOT EXISTS decision_id UUID NULL REFERENCES decisions(id) ON DELETE RESTRICT;

ALTER TABLE telegram_rillnet_review_requests
  ADD COLUMN IF NOT EXISTS decision_id UUID NULL REFERENCES decisions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_telegram_followup_reminders_decision
  ON telegram_followup_reminders(decision_id, created_at DESC)
  WHERE decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_rillnet_reviews_decision
  ON telegram_rillnet_review_requests(decision_id, created_at DESC)
  WHERE decision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION resolve_followup_decision_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_linked_followup_case_id UUID;
BEGIN
  IF NEW.decision_id IS NULL THEN
    SELECT d.id INTO NEW.decision_id
    FROM decisions d
    WHERE d.followup_case_id = NEW.followup_case_id
    ORDER BY CASE WHEN d.decision_mode = 'HUMAN_APPROVAL' THEN 0 ELSE 1 END,
             d.created_at DESC
    LIMIT 1;
  ELSE
    SELECT d.followup_case_id INTO v_linked_followup_case_id
    FROM decisions d
    WHERE d.id = NEW.decision_id;

    IF v_linked_followup_case_id IS DISTINCT FROM NEW.followup_case_id THEN
      RAISE EXCEPTION 'FOLLOWUP_DECISION_LINK_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telegram_followup_reminder_decision_link ON telegram_followup_reminders;
CREATE TRIGGER telegram_followup_reminder_decision_link
  BEFORE INSERT OR UPDATE OF followup_case_id, decision_id ON telegram_followup_reminders
  FOR EACH ROW EXECUTE FUNCTION resolve_followup_decision_link();

DROP TRIGGER IF EXISTS telegram_rillnet_review_decision_link ON telegram_rillnet_review_requests;
CREATE TRIGGER telegram_rillnet_review_decision_link
  BEFORE INSERT OR UPDATE OF followup_case_id, decision_id ON telegram_rillnet_review_requests
  FOR EACH ROW EXECUTE FUNCTION resolve_followup_decision_link();

-- Link evidence that arrived before this migration.
UPDATE telegram_followup_reminders r
SET decision_id = (
  SELECT d.id FROM decisions d
  WHERE d.followup_case_id = r.followup_case_id
  ORDER BY CASE WHEN d.decision_mode = 'HUMAN_APPROVAL' THEN 0 ELSE 1 END,
           d.created_at DESC
  LIMIT 1
)
WHERE r.decision_id IS NULL
  AND EXISTS (SELECT 1 FROM decisions d WHERE d.followup_case_id = r.followup_case_id);

UPDATE telegram_rillnet_review_requests r
SET decision_id = (
  SELECT d.id FROM decisions d
  WHERE d.followup_case_id = r.followup_case_id
  ORDER BY CASE WHEN d.decision_mode = 'HUMAN_APPROVAL' THEN 0 ELSE 1 END,
           d.created_at DESC
  LIMIT 1
)
WHERE r.decision_id IS NULL
  AND EXISTS (SELECT 1 FROM decisions d WHERE d.followup_case_id = r.followup_case_id);

-- When a Decision is created after Telegram activity, attach the outstanding
-- follow-up evidence. Existing explicit links are never overwritten.
CREATE OR REPLACE FUNCTION backfill_followup_evidence_for_decision()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.followup_case_id IS NULL THEN RETURN NEW; END IF;

  UPDATE telegram_followup_reminders
  SET decision_id = NEW.id
  WHERE followup_case_id = NEW.followup_case_id AND decision_id IS NULL;

  UPDATE telegram_rillnet_review_requests
  SET decision_id = NEW.id
  WHERE followup_case_id = NEW.followup_case_id AND decision_id IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS decisions_followup_evidence_backfill ON decisions;
CREATE TRIGGER decisions_followup_evidence_backfill
  AFTER INSERT ON decisions
  FOR EACH ROW EXECUTE FUNCTION backfill_followup_evidence_for_decision();

CREATE OR REPLACE FUNCTION audit_followup_telegram_evidence_on_decision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_decision_id UUID;
  v_status TEXT;
BEGIN
  IF NEW.event_type NOT IN ('FEEDBACK_RECEIVED', 'SIGNAL_RECEIVED') THEN RETURN NEW; END IF;

  SELECT r.decision_id INTO v_decision_id
  FROM telegram_followup_reminders r
  WHERE r.id = NEW.reminder_id;
  IF v_decision_id IS NULL THEN RETURN NEW; END IF;

  SELECT decision_status INTO v_status FROM decisions WHERE id = v_decision_id;
  INSERT INTO decision_audit_events(
    decision_id, idempotency_key, actor, previous_status, new_status, metadata, occurred_at
  ) VALUES (
    v_decision_id,
    'telegram-followup-evidence:' || NEW.id::TEXT,
    NEW.actor,
    v_status,
    v_status,
    jsonb_build_object(
      'event', 'TELEGRAM_FOLLOWUP_' || NEW.event_type,
      'reminderId', NEW.reminder_id,
      'reminderEventId', NEW.id,
      'evidence', NEW.metadata,
      'transitionedDecision', false
    ),
    NEW.occurred_at
  ) ON CONFLICT (decision_id, idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telegram_followup_evidence_decision_audit ON telegram_followup_reminder_events;
CREATE TRIGGER telegram_followup_evidence_decision_audit
  AFTER INSERT ON telegram_followup_reminder_events
  FOR EACH ROW EXECUTE FUNCTION audit_followup_telegram_evidence_on_decision();

CREATE OR REPLACE FUNCTION audit_rillnet_manager_review_on_decision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NEW.status <> 'CONFIRMED' OR OLD.status = 'CONFIRMED' OR NEW.decision_id IS NULL THEN RETURN NEW; END IF;

  SELECT decision_status INTO v_status FROM decisions WHERE id = NEW.decision_id;
  INSERT INTO decision_audit_events(
    decision_id, idempotency_key, actor, previous_status, new_status, metadata, occurred_at
  ) VALUES (
    NEW.decision_id,
    'telegram-rillnet-review:' || NEW.id::TEXT,
    COALESCE(NEW.manager_member_id::TEXT, 'telegram-manager'),
    v_status,
    v_status,
    jsonb_build_object(
      'event', 'TELEGRAM_RILLNET_MANAGER_REVIEWED',
      'reviewRequestId', NEW.id,
      'followupCaseId', NEW.followup_case_id,
      'managerOutcome', NEW.manager_outcome,
      'snapshotId', NEW.snapshot_id,
      'beforeSignature', NEW.before_signature,
      'afterSignature', NEW.after_signature,
      'transitionedDecision', false
    ),
    COALESCE(NEW.reviewed_at, NOW())
  ) ON CONFLICT (decision_id, idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telegram_rillnet_review_decision_audit ON telegram_rillnet_review_requests;
CREATE TRIGGER telegram_rillnet_review_decision_audit
  AFTER UPDATE OF status ON telegram_rillnet_review_requests
  FOR EACH ROW EXECUTE FUNCTION audit_rillnet_manager_review_on_decision();

-- Backfill immutable Decision audit references for historical employee evidence
-- and confirmed Manager reviews now that their parent records have a Decision.
INSERT INTO decision_audit_events(
  decision_id, idempotency_key, actor, previous_status, new_status, metadata, occurred_at
)
SELECT r.decision_id,
       'telegram-followup-evidence:' || e.id::TEXT,
       e.actor,
       d.decision_status,
       d.decision_status,
       jsonb_build_object(
         'event', 'TELEGRAM_FOLLOWUP_' || e.event_type,
         'reminderId', e.reminder_id,
         'reminderEventId', e.id,
         'evidence', e.metadata,
         'transitionedDecision', false,
         'backfilled', true
       ),
       e.occurred_at
FROM telegram_followup_reminder_events e
JOIN telegram_followup_reminders r ON r.id = e.reminder_id
JOIN decisions d ON d.id = r.decision_id
WHERE e.event_type IN ('FEEDBACK_RECEIVED', 'SIGNAL_RECEIVED')
ON CONFLICT (decision_id, idempotency_key) DO NOTHING;

INSERT INTO decision_audit_events(
  decision_id, idempotency_key, actor, previous_status, new_status, metadata, occurred_at
)
SELECT r.decision_id,
       'telegram-rillnet-review:' || r.id::TEXT,
       COALESCE(r.manager_member_id::TEXT, 'telegram-manager'),
       d.decision_status,
       d.decision_status,
       jsonb_build_object(
         'event', 'TELEGRAM_RILLNET_MANAGER_REVIEWED',
         'reviewRequestId', r.id,
         'followupCaseId', r.followup_case_id,
         'managerOutcome', r.manager_outcome,
         'snapshotId', r.snapshot_id,
         'beforeSignature', r.before_signature,
         'afterSignature', r.after_signature,
         'transitionedDecision', false,
         'backfilled', true
       ),
       COALESCE(r.reviewed_at, r.updated_at)
FROM telegram_rillnet_review_requests r
JOIN decisions d ON d.id = r.decision_id
WHERE r.status = 'CONFIRMED'
ON CONFLICT (decision_id, idempotency_key) DO NOTHING;

COMMENT ON COLUMN telegram_followup_reminders.decision_id IS
  'Level C evidence link. Employee feedback remains evidence-only and never transitions the Decision.';
COMMENT ON COLUMN telegram_rillnet_review_requests.decision_id IS
  'Level C evidence link. Manager Rillnet classification remains distinct from Decision approval.';
