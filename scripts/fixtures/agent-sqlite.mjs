/* Test-only D1 facade backed by actual SQLite. No provider or production state. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PYTHON = String.raw`
import json, sqlite3, sys
data=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1],timeout=10)
db.row_factory=sqlite3.Row
try:
    db.executescript(data['schema'])
    if data.get('batch'): db.execute('BEGIN IMMEDIATE')
    out=[]
    for q in data['queries']:
        before=db.total_changes
        cursor=db.execute(q['sql'],q.get('params',[]))
        rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
        out.append({'success':True,'results':rows,'meta':{'changes':db.total_changes-before}})
    db.commit()
    print(json.dumps({'result':out}))
except Exception as error:
    db.rollback()
    print(json.dumps({'error':str(error)}))
finally:
    db.close()
`;
export function createAgentSQLiteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tiger-agent-policy-'));
  const path = join(directory, 'private.sqlite');
  const schema = ['0001_agent.sql','0003_agent_storage.sql'].map(file =>
    readFileSync(new URL('../../cloudflare/migrations/' + file, import.meta.url), 'utf8')).join('\n');
  async function execute(queries, batch = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', PYTHON, path], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(Error(errors || 'SQLite test fixture failed'));
        try { const value = JSON.parse(output); if (value.error) reject(Error(value.error)); else resolve(value.result); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ schema, queries, batch }));
    });
  }
  const db = {
    prepare(sql) { return { bind(...params) { return { sql, params,
      first: async () => (await execute([{ sql, params }]))[0].results[0] ?? null,
      all: async () => (await execute([{ sql, params }]))[0],
      run: async () => (await execute([{ sql, params }]))[0],
    }; } }; },
    batch: statements => execute(statements.map(({ sql, params }) => ({ sql, params })), true),
  };
  return { db, raw: async (sql, params = []) => (await execute([{ sql, params }]))[0].results,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}
