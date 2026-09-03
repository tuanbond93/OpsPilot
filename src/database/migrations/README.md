# Database Migrations

Place Supabase / SQL migration files in this directory.

## Release discipline

- Never edit an already-applied migration. Add the next numbered migration for every schema or function change.
- Before deploying application code, verify that the target database exposes every table, column and RPC required by the new release.
- `supabase migration list` is authoritative only when the remote migration-history table has been maintained. An empty list is an unknown state, not proof that the schema is current.
- Scheduler changes require separate evidence for the installed function, Vault configuration and active `cron.job` entry.
