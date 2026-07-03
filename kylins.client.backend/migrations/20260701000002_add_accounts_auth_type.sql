-- Phase 3b: EAS hardening. auth_type so the EAS source picks Basic vs OAuth.
-- Default null = Basic (preserves existing rows).
ALTER TABLE accounts ADD COLUMN auth_type TEXT;
