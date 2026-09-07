import type { Request } from 'express';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { encodeJson } from '../lib/columns';

interface AuditInput {
  actorType: 'admin' | 'client' | 'system';
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  req?: Request;
}

/**
 * Writes an append-only audit entry.
 *
 * Auditing must never break the request it is describing, so failures are
 * logged and swallowed. Every configuration mutation and every authentication
 * outcome goes through here.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const { req } = input;

    await prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: req?.admin?.id ?? req?.client?.id ?? null,
        actorLabel: req?.admin?.email ?? req?.client?.name ?? null,
        action: input.action,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        before: encodeJson(input.before),
        after: encodeJson(input.after),
        ip: req?.ip ?? null,
        userAgent: req?.header('user-agent')?.slice(0, 512) ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log entry');
  }
}
