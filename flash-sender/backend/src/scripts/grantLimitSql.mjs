/**
 * Grants a spending limit without Prisma.
 *
 *   node src/scripts/grantLimitSql.mjs
 *   node src/scripts/grantLimitSql.mjs --client <id> --asset <id> --per-tx 100 --per-day 500
 *   node src/scripts/grantLimitSql.mjs --client <id> --asset <id> --revoke
 *
 * Same job as grantLimit.ts, for hosts where the Prisma query engine panics
 * ("timer has gone away" — a thread the shared-hosting process limit would not
 * let it keep). This talks to MySQL through the `mysql` command-line client
 * instead, and if that is missing too it prints the SQL to paste into
 * phpMyAdmin. Plain .mjs, so it needs no TypeScript loader either.
 *
 * Credentials come from DATABASE_URL in .env and are passed to the client in a
 * 0600 defaults-file, never on the command line where `ps` would show them.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// --- connection details ------------------------------------------------------

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  let env;
  try {
    env = readFileSync('.env', 'utf8');
  } catch {
    fail('No DATABASE_URL set and no .env in this directory. Run this from your app root.');
  }

  const line = env.split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
  if (!line) fail('No DATABASE_URL line found in .env.');

  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

function connection() {
  const url = new URL(databaseUrl());
  return {
    host: url.hostname || 'localhost',
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

/** Runs SQL through the mysql client, returning rows as arrays of strings. */
function query(sql) {
  const conn = connection();
  const dir = mkdtempSync(join(tmpdir(), 'fsgl-'));
  const cnf = join(dir, 'my.cnf');

  writeFileSync(
    cnf,
    `[client]\nhost=${conn.host}\nport=${conn.port}\nuser=${conn.user}\n` +
      `password="${conn.password.replace(/"/g, '\\"')}"\n`,
    { mode: 0o600 },
  );
  chmodSync(cnf, 0o600);

  try {
    const out = execFileSync('mysql', [`--defaults-file=${cnf}`, '-N', '-B', conn.database], {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() ? out.trim().split('\n').map((row) => row.split('\t')) : [];
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        '\n✗ The `mysql` command is not available here.\n\n' +
          '  Paste this into phpMyAdmin (cPanel → phpMyAdmin → your database → SQL):\n',
      );
      console.error(sql.replace(/^/gm, '    '));
      process.exit(1);
    }
    fail((err.stderr || err.message).toString().trim());
  }
}

/** Escapes a value for a single-quoted SQL string literal. */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** Human units → base units, exactly, without floating point. */
function toBaseUnits(amount, decimals) {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    fail(`"${amount}" is not a positive number. Use plain digits, e.g. 100 or 0.05.`);
  }

  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) {
    fail(`This asset has ${decimals} decimals, so "${amount}" is more precise than it can hold.`);
  }

  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

// --- commands ----------------------------------------------------------------

function list() {
  const clients = query('SELECT id, name, isActive FROM api_clients ORDER BY createdAt;');
  const assets = query('SELECT assetId, symbol, decimals FROM assets ORDER BY symbol;');
  const limits = query('SELECT clientId, assetId FROM spending_limits WHERE enabled = 1;');

  const lines = ['', 'Installations (--client):', ''];

  if (!clients.length) lines.push('  (none — issue one with npm run create-api-key)');

  for (const [id, name, active] of clients) {
    const granted = limits.filter(([clientId]) => clientId === id).map(([, assetId]) => assetId);
    lines.push(`  ${id}`);
    lines.push(
      `    ${name}${active === '1' ? '' : '  [revoked]'}  →  can send: ` +
        (granted.length ? granted.join(', ') : 'nothing — cannot send'),
    );
  }

  lines.push('', 'Assets (--asset):', '');

  if (!assets.length) lines.push('  (none — add one in the dashboard)');

  for (const [assetId, symbol, decimals] of assets) {
    lines.push(`  ${assetId.padEnd(20)} ${symbol} (${decimals} decimals)`);
  }

  lines.push(
    '',
    'Then:',
    '  node src/scripts/grantLimitSql.mjs --client <id> --asset <id> --per-tx 100 --per-day 500',
    '',
  );

  console.log(lines.join('\n'));
}

function main() {
  const clientId = arg('client');
  const assetId = arg('asset');

  if (!clientId || !assetId) return list();

  const [client] = query(`SELECT name FROM api_clients WHERE id = ${q(clientId)};`);
  if (!client) fail(`No installation with id "${clientId}". Run with no arguments to list them.`);

  const [asset] = query(`SELECT symbol, decimals FROM assets WHERE assetId = ${q(assetId)};`);
  if (!asset) fail(`No asset with id "${assetId}". Run with no arguments to list them.`);

  const [name] = client;
  const [symbol, decimalsText] = asset;
  const decimals = Number(decimalsText);

  if (has('revoke')) {
    query(
      `DELETE FROM spending_limits WHERE clientId = ${q(clientId)} AND assetId = ${q(assetId)};`,
    );
    console.log(`\n✓ ${name} can no longer send ${symbol}.\n`);
    return;
  }

  const perTx = arg('per-tx');
  const perDay = arg('per-day');

  if (!perTx || !perDay) {
    fail('Both --per-tx and --per-day are required (in whole tokens, e.g. --per-tx 100).');
  }

  const maxPerTxRaw = toBaseUnits(perTx, decimals);
  const maxPerDayRaw = toBaseUnits(perDay, decimals);

  if (BigInt(maxPerTxRaw) > BigInt(maxPerDayRaw)) {
    fail('The per-transaction limit cannot exceed the daily limit.');
  }

  // Upsert by hand: the unique key is (clientId, assetId).
  query(
    `INSERT INTO spending_limits (id, clientId, assetId, maxPerTxRaw, maxPerDayRaw, enabled, updatedAt)\n` +
      `VALUES (${q(randomBytes(16).toString('hex'))}, ${q(clientId)}, ${q(assetId)}, ` +
      `${q(maxPerTxRaw)}, ${q(maxPerDayRaw)}, 1, NOW(3))\n` +
      `ON DUPLICATE KEY UPDATE maxPerTxRaw = VALUES(maxPerTxRaw), ` +
      `maxPerDayRaw = VALUES(maxPerDayRaw), enabled = 1, updatedAt = NOW(3);`,
  );

  console.log(
    [
      '',
      `✓ ${name} may now send ${symbol}:`,
      `    up to ${perTx} ${symbol} per transaction   (${maxPerTxRaw} base units)`,
      `    up to ${perDay} ${symbol} per day`,
      '',
      '  No restart needed — the limit is checked on every send.',
      '',
    ].join('\n'),
  );
}

main();
