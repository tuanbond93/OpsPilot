import pg from "pg";
import fs from "fs";
import path from "path";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";

async function applyMigrations() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  console.log("Applying migrations to STAGING only:", env.projectRef);

  const client = new pg.Client({
    host: "aws-0-ap-southeast-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${env.projectRef}`,
    password: env.dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS public._schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `);

  const appliedRes = await client.query("SELECT version FROM public._schema_migrations;");
  const appliedSet = new Set(appliedRes.rows.map(r => r.version));

  const migrationsDir = path.resolve(process.cwd(), "src/database/migrations");
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  console.log(`Found ${files.length} migration files in ${migrationsDir}`);

  let newlyApplied = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    let sql = fs.readFileSync(filePath, "utf-8");

    process.stdout.write(`Applying ${file}... `);
    const start = Date.now();

    try {
      // Check if migration has ALTER TYPE ... ADD VALUE
      // Postgres requires ALTER TYPE ... ADD VALUE to be committed before the new value is referenced.
      const alterTypeRegex = /ALTER\s+TYPE\s+[^;]+ADD\s+VALUE[^;]+;/gi;
      const alterTypeMatches = sql.match(alterTypeRegex);

      if (alterTypeMatches && alterTypeMatches.length > 0) {
        for (const alterStmt of alterTypeMatches) {
          try {
            await client.query(alterStmt);
          } catch (e) {
            // Already exists or harmless
          }
        }
        // Remove the ALTER TYPE statements from the remaining SQL
        const remainingSql = sql.replace(alterTypeRegex, "");
        if (remainingSql.trim().length > 0) {
          await client.query(remainingSql);
        }
      } else {
        await client.query(sql);
      }

      await client.query(
        "INSERT INTO public._schema_migrations (version) VALUES ($1);",
        [file]
      );
      const elapsed = Date.now() - start;
      console.log(`OK (${elapsed}ms)`);
      newlyApplied++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      console.error(`Error in migration ${file}:`, err.message);
      throw err;
    }
  }

  console.log(`Migration run complete: ${newlyApplied} newly applied.`);
  await client.end();
}

applyMigrations().catch(err => {
  console.error("MIGRATION_HALTED:", err.message);
  process.exit(1);
});
