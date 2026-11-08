/** Typed domain errors. `errorResponse` maps `status` straight to the HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** The request is well formed but conflicts with the current state (a stale update, a cap reached). */
export class ConflictError extends HttpError {
  constructor(message = "That change isn't allowed from the current state.") {
    super(409, message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `Body too large (limit ${limit} bytes)`);
  }
}

/** Too many attempts in a window (for example share attempts per hour). */
export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}

/** The request is well formed but the content is unacceptable (for example a file that isn't the image it claims to be). */
export class UnprocessableError extends HttpError {
  constructor(message = "Unprocessable") {
    super(422, message);
  }
}
