import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../lib/errors.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('http');

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

// Express identifies error handlers by arity, so the 4th parameter must stay.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details: unknown;

  if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues;
  } else if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.expose ? err.message : 'Internal server error';
    if (err.expose) details = err.details;
  } else if (err instanceof Error) {
    message = 'Internal server error';
  }

  if (status >= 500) {
    log.error(
      { err, requestId: req.requestId, path: req.path, method: req.method },
      'unhandled error',
    );
  } else {
    log.warn({ code, requestId: req.requestId, path: req.path, status }, 'request rejected');
  }

  const body: ErrorBody = { error: { code, message, requestId: req.requestId } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
}
