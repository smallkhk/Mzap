import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { config } from '../config';

/** 404 for unmatched routes, in the same envelope as every other error. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `${req.method} ${req.path} is not an endpoint of this API.`,
    },
  });
}

/**
 * Terminal error handler.
 *
 * Every failure leaves here as `{ error: { code, message, details? } }` with
 * a message written for a person. Internal details (stack traces, driver
 * messages) are logged, never returned.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, 'Application error');
    else logger.warn({ code: err.code, path: req.path, msg: err.message }, 'Request rejected');

    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
      return res.status(409).json({
        error: {
          code: 'DUPLICATE',
          message: `A record with that ${target} already exists.`,
        },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'The requested record could not be found.' },
      });
    }
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: {
          code: 'IN_USE',
          message:
            'That record is referenced by other data and cannot be removed. Disable it instead.',
        },
      });
    }
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The server encountered an unexpected problem. The incident has been logged.',
      details: config.isProduction ? undefined : String(err),
    },
  });
}
