import MessageValidator from "sns-validator";

// This is the half of the architecture that DOES get cryptographic
// signature verification. Daraja can't offer this (no private key on
// your side of that relationship) — but SNS signs every message it
// delivers with a certificate you can check, because it's infrastructure
// you and AWS both trust. sns-validator checks the signature against the
// cert at SigningCertURL (restricted to *.amazonaws.com by the library)
// and that the topic ARN matches what you expect.
const validator = new MessageValidator();

export function verifySnsMessage<T = unknown>(rawBody: T): Promise<T> {
  return new Promise((resolve, reject) => {
    validator.validate(rawBody as never, (err: Error | null) => {
      if (err) reject(err);
      else resolve(rawBody);
    });
  });
}
