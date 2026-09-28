import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Only a local/dev run echoes an unhandled error's own text back to the
 * caller. Anything deployed answers with the status and a neutral sentence,
 * and keeps the detail in the log.
 *
 * Read per request, not once at import: bootstrap order decides when NODE_ENV
 * is set, and a module-load snapshot silently disables this if the filter
 * happens to be imported first.
 */
function showInternalErrors(): boolean {
  return process.env.NODE_ENV !== 'production';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;
    let error: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : (res as any).message || exception.message;
      error = (res as any).error || HttpStatus[status] || 'Error';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      error = 'Internal Server Error';
      // An unhandled error's own message is written for whoever reads the
      // logs, not for whoever made the request. A Prisma failure, for one,
      // renders as the deployed source path plus the lines around the call:
      //
      //   Invalid `this.prisma.blogCategory.create()` invocation in
      //   /home/yukizi_deploy/yakuzi-api/src/modules/blog/blog.service.ts:494
      //
      // That reached a browser, and would reach anyone who could provoke any
      // unhandled error anywhere in this API. The detail still goes to the
      // logger below, with the stack; outside development the client gets the
      // status and nothing else.
      message = showInternalErrors() && exception instanceof Error
        ? exception.message
        : 'Something went wrong on our side. Please try again.';
    }


    const errorResponse = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    this.logger.error(
      `${request.method} ${request.url} ${status} — ${typeof message === 'string' ? message : JSON.stringify(message)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json(errorResponse);
  }
}

