import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id set by the requestContext middleware. */
      requestId: string;
    }
  }
}

export {};
