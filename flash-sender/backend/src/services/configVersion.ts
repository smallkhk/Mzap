import { prisma } from '../lib/db';

/**
 * Monotonic configuration version.
 *
 * Any mutation to networks or assets bumps this counter. The desktop client
 * polls GET /api/config/version (a tiny, cacheable response) and only re-pulls
 * the full asset list when the number changes — that is what makes "add a
 * token in the admin panel, it appears in the app" work with no rebuild and
 * no polling of the heavy endpoint.
 */
export async function getConfigVersion(): Promise<number> {
  const row = await prisma.configVersion.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, version: 1 },
  });
  return row.version;
}

export async function bumpConfigVersion(): Promise<number> {
  const row = await prisma.configVersion.upsert({
    where: { id: 1 },
    update: { version: { increment: 1 } },
    create: { id: 1, version: 2 },
  });
  return row.version;
}
