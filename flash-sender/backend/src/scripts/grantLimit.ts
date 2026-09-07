/**
 * Grants one installation permission to send one asset, up to a cap.
 *
 *   npm run grant-limit                                  # list clients + assets
 *   npm run grant-limit -- --client <id> --asset <id> --per-tx 100 --per-day 500
 *   npm run grant-limit -- --client <id> --asset <id> --revoke
 *
 * The same thing the dashboard's "Spending limits" panel does, for when it is
 * easier to reach a shell than a browser. It talks to the database directly,
 * so it needs no admin login, no access token and no jq.
 *
 * Amounts are in human units — "100" means 100 tokens, not 100 wei.
 */
import { prisma } from '../lib/db';
import { formatAmount, parseAmount } from '../lib/amount';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const has = (name: string) => process.argv.includes(`--${name}`);

/** Prints what is available, so the ids never have to be guessed. */
async function listEverything() {
  // Sequential on purpose. Concurrent queries against a query engine that is
  // still starting panic with "timer has gone away" on some hosts, and this
  // script is short-lived, so the engine is always cold when it runs.
  const clients = await prisma.apiClient.findMany({ orderBy: { createdAt: 'asc' } });
  const assets = await prisma.asset.findMany({ orderBy: { symbol: 'asc' } });
  const limits = await prisma.spendingLimit.findMany();

  const lines: string[] = ['', 'Installations (--client):', ''];

  if (!clients.length) lines.push('  (none — issue one with npm run create-api-key)');

  for (const client of clients) {
    const granted = limits.filter((l) => l.clientId === client.id);
    const summary = granted.length
      ? granted.map((l) => l.assetId).join(', ')
      : 'nothing — cannot send';
    lines.push(`  ${client.id}`);
    lines.push(`    ${client.name}${client.isActive ? '' : '  [revoked]'}  →  can send: ${summary}`);
  }

  lines.push('', 'Assets (--asset):', '');

  if (!assets.length) lines.push('  (none — add one in the dashboard)');

  for (const asset of assets) {
    lines.push(`  ${asset.assetId.padEnd(20)} ${asset.symbol} (${asset.decimals} decimals)`);
  }

  lines.push(
    '',
    'Then:',
    '  npm run grant-limit -- --client <id> --asset <id> --per-tx 100 --per-day 500',
    '',
  );

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

async function main() {
  // Open the connection before any query, so the engine is up rather than
  // being started underneath the first one.
  await prisma.$connect();

  const clientId = arg('client');
  const assetId = arg('asset');

  if (!clientId || !assetId) {
    await listEverything();
    return;
  }

  const client = await prisma.apiClient.findUnique({ where: { id: clientId } });
  if (!client) throw new Error(`No installation with id "${clientId}". Run with no arguments to list them.`);

  const asset = await prisma.asset.findUnique({ where: { assetId } });
  if (!asset) throw new Error(`No asset with id "${assetId}". Run with no arguments to list them.`);

  if (has('revoke')) {
    await prisma.spendingLimit.deleteMany({ where: { clientId, assetId } });
    // eslint-disable-next-line no-console
    console.log(`\n✓ ${client.name} can no longer send ${asset.symbol}.\n`);
    return;
  }

  const perTx = arg('per-tx');
  const perDay = arg('per-day');

  if (!perTx || !perDay) {
    throw new Error('Both --per-tx and --per-day are required (in whole tokens, e.g. --per-tx 100).');
  }

  const maxPerTxRaw = parseAmount(perTx, asset.decimals, asset.symbol);
  const maxPerDayRaw = parseAmount(perDay, asset.decimals, asset.symbol);

  if (maxPerTxRaw > maxPerDayRaw) {
    throw new Error('The per-transaction limit cannot exceed the daily limit.');
  }

  await prisma.spendingLimit.upsert({
    where: { clientId_assetId: { clientId, assetId } },
    update: {
      maxPerTxRaw: maxPerTxRaw.toString(),
      maxPerDayRaw: maxPerDayRaw.toString(),
      enabled: true,
    },
    create: {
      clientId,
      assetId,
      maxPerTxRaw: maxPerTxRaw.toString(),
      maxPerDayRaw: maxPerDayRaw.toString(),
      enabled: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `✓ ${client.name} may now send ${asset.symbol}:`,
      `    up to ${formatAmount(maxPerTxRaw, asset.decimals)} ${asset.symbol} per transaction`,
      `    up to ${formatAmount(maxPerDayRaw, asset.decimals)} ${asset.symbol} per day`,
      '',
      '  No restart needed — the limit is checked on every send.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
