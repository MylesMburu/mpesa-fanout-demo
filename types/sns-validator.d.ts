declare module "sns-validator" {
  export default class MessageValidator {
    constructor(hostPattern?: RegExp, encoding?: string, opts?: Record<string, unknown>);
    validate(
      message: Record<string, unknown>,
      callback: (err: Error | null, message?: Record<string, unknown>) => void
    ): void;
  }
}
