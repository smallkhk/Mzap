/**
 * Issues an API key for a desktop installation.
 *
 *   npm run create-api-key -- --name "Nora's workstation"
 *
 * The key is printed once. Paste it into the desktop app under Settings →
 * Backend. Only its SHA-256 digest is stored here.
 */
import { prisma } from '../lib/db';
import { generateApiKey } from '../lib/crypto';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const name = arg('name') ?? `desktop-${new Date().toISOString().slice(0, 10)}`;
  const { key, hash, prefix } = generateApiKey();

  const client = await prisma.apiClient.create({
    data: { name, keyHash: hash, keyPrefix: prefix },
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `✓ API client created: ${client.name}`,
      '',
      '  API key (shown once — copy it now):',
      '',
      `    ${key}`,
      '',
      '  Paste this into the desktop app: Settings → Backend → API key.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
