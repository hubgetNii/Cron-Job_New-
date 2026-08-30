import 'express';
import type { RbacRole } from '../domain/enums.js';

declare global {
  namespace Express {
    interface AuthedUser {
      id: string;
      email: string;
      roles: RbacRole[];
    }
    interface Request {
      /** Correlation id set by the requestContext middleware. */
      requestId: string;
      /** Present once `authenticate` has run and auth is enabled. */
      user?: AuthedUser;
    }
  }
}

export {};
