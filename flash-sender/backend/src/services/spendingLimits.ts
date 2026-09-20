import type { Request } from 'express';
import { prisma } from '../lib/db';
import { formatAmount, parseAmount } from '../lib/amount';
import { badRequest } from '../lib/errors';
import { recordAudit } from './audit';

/**
 * Reading and writing spending limits, shared between the admin dashboard
 * (which can act on any client) and the self-service portal (which can only
 * ever act on the one client it authenticated as).
 *
 * Every function here is scoped by the `clientId` the caller passes in —
 * nothing in this module trusts a client to name itself. The portal route
 * always passes `req.client.id`; the admin route passes whatever `:id` an
 * administrator picked. That boundary is enforced by the callers, not here.
 */

export interface LimitInput {
  assetId: string;
  maxPerTx: string;
  maxPerDay: string;
  enabled: boolean;
}

/** Human-unit view of one client's limits, for either dashboard. */
export async function listLimitsFor(clientId: string) {
  const limits = await prisma.spendingLimit.findMany({
    where: { clientId },
    orderBy: { assetId: 'asc' },
  });

  // Limits are stored in base units; present them in human units alongside
  // the asset so neither dashboard has to know about decimals.
  const assets = await prisma.asset.findMany({
    where: { assetId: { in: limits.map((l) => l.assetId) } },
  });
  const decimalsByAsset = new Map(assets.map((a) => [a.assetId, a.decimals]));

  return limits.map((limit) => {
    const decimals = decimalsByAsset.get(limit.assetId) ?? 18;
    return {
      assetId: limit.assetId,
      maxPerTx: formatAmount(limit.maxPerTxRaw, decimals),
      maxPerDay: formatAmount(limit.maxPerDayRaw, decimals),
      enabled: limit.enabled,
    };
  });
}

/**
 * Grants or updates one asset's cap for one client. Because a client with no
 * limit row cannot send an asset at all, this is also how sending access is
 * granted in the first place — by an administrator for any client, or by a
 * portal-enabled client for itself.
 */
export async function setLimitFor(
  clientId: string,
  clientName: string,
  input: LimitInput,
  actorType: 'admin' | 'client',
  req: Request,
) {
  const asset = await prisma.asset.findUnique({ where: { assetId: input.assetId } });
  if (!asset) throw badRequest('UNKNOWN_ASSET', `No asset with id "${input.assetId}".`);

  const maxPerTxRaw = parseAmount(input.maxPerTx, asset.decimals, asset.symbol);
  const maxPerDayRaw = parseAmount(input.maxPerDay, asset.decimals, asset.symbol);

  if (maxPerTxRaw > maxPerDayRaw) {
    throw badRequest(
      'LIMIT_INCONSISTENT',
      'The per-transaction limit cannot exceed the daily limit.',
    );
  }

  const limit = await prisma.spendingLimit.upsert({
    where: { clientId_assetId: { clientId, assetId: input.assetId } },
    update: {
      maxPerTxRaw: maxPerTxRaw.toString(),
      maxPerDayRaw: maxPerDayRaw.toString(),
      enabled: input.enabled,
    },
    create: {
      clientId,
      assetId: input.assetId,
      maxPerTxRaw: maxPerTxRaw.toString(),
      maxPerDayRaw: maxPerDayRaw.toString(),
      enabled: input.enabled,
    },
  });

  await recordAudit({
    actorType,
    action: 'limit.set',
    entity: 'SpendingLimit',
    entityId: limit.id,
    after: {
      client: clientName,
      assetId: input.assetId,
      maxPerTx: input.maxPerTx,
      maxPerDay: input.maxPerDay,
      enabled: input.enabled,
    },
    req,
  });

  return { assetId: input.assetId, maxPerTx: input.maxPerTx, maxPerDay: input.maxPerDay, enabled: limit.enabled };
}

/** Revokes one client's access to one asset. */
export async function revokeLimitFor(
  clientId: string,
  assetId: string,
  actorType: 'admin' | 'client',
  req: Request,
) {
  await prisma.spendingLimit.deleteMany({ where: { clientId, assetId } });

  await recordAudit({
    actorType,
    action: 'limit.revoke',
    entity: 'SpendingLimit',
    after: { clientId, assetId },
    req,
  });
}
