// Domain errors carry the HTTP status they map to; the HTTP layer renders them
// as application/problem+json.

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "validation_failed", details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Sign in required.") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You don't have permission for this.") {
    super(message, 403, "forbidden");
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 409, "conflict", details);
  }
}
