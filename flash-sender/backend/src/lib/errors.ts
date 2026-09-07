/**
 * Application errors carry a stable machine-readable `code` alongside a
 * message written for a human. The desktop app maps the code to a localised
 * string; the message is the fallback. Neither is ever just "Error".
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'Authentication is required to access this resource.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Your account is not permitted to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (what: string) =>
  new AppError(404, 'NOT_FOUND', `${what} could not be found.`);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const tooManyRequests = (message = 'Too many requests. Please slow down and try again.') =>
  new AppError(429, 'RATE_LIMITED', message);
