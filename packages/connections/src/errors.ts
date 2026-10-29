/** Domain error with an HTTP-friendly status; the API maps it 1:1 onto its error envelope. */
export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const notFound = (what: string) => new ServiceError(404, 'not_found', `${what} not found`);
