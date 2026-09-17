-- Supabase Advisor flagged all 7 application tables as publicly exposed
-- with Row Level Security disabled (Critical). This app never uses
-- Supabase's PostgREST/Auth layer -- apps/api connects directly with the
-- full postgres role, which owns these tables and bypasses RLS regardless
-- of policy. Enabling RLS with no policies is therefore safe for our own
-- access path, and closes the real exposure: without this, anyone with
-- the project's anon key could read/write these tables through Supabase's
-- auto-generated REST API, since RLS-disabled tables have no access
-- control at that layer.
--
-- No policies are added because no role other than the table owner
-- (our backend's connection) is meant to access these tables at all. If a
-- future need arises for the anon/authenticated roles to read specific
-- rows (e.g. a browser client reading its own account directly via
-- Supabase), add explicit policies then -- do not widen this blanket deny.

alter table protected_accounts enable row level security;
alter table account_risk_heads enable row level security;
alter table rule_versions enable row level security;
alter table risk_days enable row level security;
alter table decision_artifacts enable row level security;
alter table order_reservations enable row level security;
alter table state_checkpoints enable row level security;
