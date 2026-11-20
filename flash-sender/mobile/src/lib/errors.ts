/**
 * An error with a stable code and a message written for a person. Nothing in
 * this app surfaces a bare "Error" — every failure path constructs one of
 * these, usually via `apiRequest`'s own translation of the backend's
 * response.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
