export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'unauthenticated', 'Authentication required');
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', msg);
/** Also used for resources the caller may not see, so existence is never leaked. */
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
