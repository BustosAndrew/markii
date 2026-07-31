import { ApiClientError } from "./types";

export class PlannedError extends Error {
  section: string;

  constructor(section: string, message = `${section} is not available yet`) {
    super(message);
    this.name = "PlannedError";
    this.section = section;
  }
}

export function isPlannedError(error: unknown): error is PlannedError {
  return error instanceof PlannedError;
}

export function isEndpointMissing(error: unknown) {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 501);
}

export function toPlannedError(error: unknown, section: string): never {
  if (isPlannedError(error)) {
    throw error;
  }

  if (isEndpointMissing(error)) {
    throw new PlannedError(section);
  }

  throw error;
}

export async function callWhenLive<T>(
  live: boolean,
  section: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!live) {
    throw new PlannedError(section);
  }

  try {
    return await fn();
  } catch (error) {
    toPlannedError(error, section);
  }
}
