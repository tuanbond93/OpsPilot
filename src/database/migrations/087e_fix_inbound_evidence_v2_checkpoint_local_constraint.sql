-- Migration 087E: correct the Natural Shadow local-checkpoint regex.
-- The governed value is an explicit Asia/Ho_Chi_Minh (+07:00) text timestamp.
BEGIN;

ALTER TABLE public.inbound_evidence_v2_natural_shadow_checkpoints
  DROP CONSTRAINT inbound_evidence_v2_natural_shadow_ch_checkpoint_at_local_check;

ALTER TABLE public.inbound_evidence_v2_natural_shadow_checkpoints
  ADD CONSTRAINT inbound_evidence_v2_natural_shadow_ch_checkpoint_at_local_check
  CHECK (
    checkpoint_at_local ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?[+]07:00$'
  );

COMMIT;
