export class SubscriptionAuthError extends Error {
  override readonly name = "SubscriptionAuthError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
