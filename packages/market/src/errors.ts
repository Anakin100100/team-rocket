// A refused market action. Agents and MCP clients get `code` and `message`
// back as data, so they can correct course instead of failing.
export type MarketErrorCode =
  | "NOT_FOUND"
  | "GUARD_FAILED"
  | "INVALID_INPUT"
  | "FORBIDDEN";

export class MarketError extends Error {
  readonly code: MarketErrorCode;

  constructor(code: MarketErrorCode, message: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

export const guardFailed = (message: string) =>
  new MarketError("GUARD_FAILED", message);

export const notFound = (message: string) =>
  new MarketError("NOT_FOUND", message);

export const forbidden = (message: string) =>
  new MarketError("FORBIDDEN", message);
