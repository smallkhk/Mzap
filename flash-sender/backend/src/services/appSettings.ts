import { prisma } from '../lib/db';
import { normaliseAddress } from '../lib/chain';

/**
 * The buy feature's admin-editable settings: single row, same pattern as
 * `configVersion.ts`. A DB row rather than an env var on purpose — the
 * markup and its destination change from the dashboard, with no redeploy.
 */
export interface BuySettings {
  buyMarkupBps: number;
  profitAddress: string | null;
}

export async function getBuySettings(): Promise<BuySettings> {
  const row = await prisma.appSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  return { buyMarkupBps: row.buyMarkupBps, profitAddress: row.profitAddress };
}

export async function setBuySettings(input: {
  buyMarkupBps?: number;
  profitAddress?: string | null;
}): Promise<BuySettings> {
  const data: { buyMarkupBps?: number; profitAddress?: string | null } = {};

  if (input.buyMarkupBps !== undefined) data.buyMarkupBps = input.buyMarkupBps;
  if (input.profitAddress !== undefined) {
    data.profitAddress = input.profitAddress ? normaliseAddress(input.profitAddress) : null;
  }

  const row = await prisma.appSetting.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });

  return { buyMarkupBps: row.buyMarkupBps, profitAddress: row.profitAddress };
}
