import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const db = new Database(join(homedir(), '.openzigs', 'openzigs.db'));
const action = process.argv[2];

if (action === 'tables') {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(tables.map(t => t.name).join(', '));
} else if (action === 'reset-failed') {
  // Reset failed txt2video jobs back to pending
  const ids = process.argv.slice(3);
  for (const id of ids) {
    db.prepare("UPDATE media_jobs SET status = 'pending', error = NULL, dispatched_at = NULL WHERE id = ?").run(id);
    console.log(`Reset ${id} to pending`);
  }
} else if (action === 'all-jobs') {
  const rows = db.prepare("SELECT id, type, status, error, created_at FROM media_jobs ORDER BY created_at DESC LIMIT 30").all();
  for (const r of rows) {
    console.log(`${r.id} | ${r.type} | ${r.status} | ${(r.error || '').substring(0, 60)}`);
  }
} else if (action === 'pipeline') {
  // Show all jobs with payload containing the pipeline ID
  const pid = process.argv[3];
  const rows = db.prepare("SELECT id, type, status, error, payload FROM media_jobs WHERE payload LIKE ?").all(`%${pid}%`);
  for (const r of rows) {
    console.log(`${r.id} | ${r.type} | ${r.status} | ${(r.error || '').substring(0, 60)}`);
  }
} else if (action === 'fail-orphans') {
  const r = db.prepare("UPDATE media_jobs SET status = 'failed', error = 'Orphaned - pipeline state lost on reload' WHERE status IN ('pending', 'dispatched') AND payload LIKE '%pipeline_id%'").run();
  console.log(`Failed ${r.changes} orphaned pipeline jobs`);
} else {
  console.log('Usage: node check-jobs.mjs [tables|reset-failed <ids...>|all-jobs|pipeline <id>|fail-orphans]');
}

db.close();
