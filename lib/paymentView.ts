// The only shape the browser is allowed to see. Daraja result codes,
// CheckoutRequestIDs, and SNS stay on the server.

export type PaymentStatusName = "pending" | "paid" | "failed" | "timed_out";

export type PaymentStatusResponse = {
  status: PaymentStatusName;
  amount: number;
  receiptNumber: string | null;
  reason: string | null;
  steps: {
    stkPushSent: boolean;
    callbackReceived: boolean;
    notified: boolean;
    audited: boolean;
  };
};

type PaymentRow = {
  status: "PENDING" | "PAID" | "FAILED" | "TIMED_OUT";
  amount: number;
  mpesaReceiptNumber: string | null;
  resultDesc: string | null;
  checkoutRequestId: string | null;
  notifiedAt: Date | null;
  auditedAt: Date | null;
};

const STATUS_NAME = {
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
} as const;

export function toStatusResponse(payment: PaymentRow): PaymentStatusResponse {
  return {
    status: STATUS_NAME[payment.status],
    amount: payment.amount,
    receiptNumber: payment.mpesaReceiptNumber,
    reason: payment.resultDesc,
    steps: {
      stkPushSent: Boolean(payment.checkoutRequestId),
      // A timeout means we have not heard a result. Query-or-callback
      // resolution is what lights this step.
      callbackReceived: payment.status === "PAID" || payment.status === "FAILED",
      notified: Boolean(payment.notifiedAt),
      audited: Boolean(payment.auditedAt),
    },
  };
}
