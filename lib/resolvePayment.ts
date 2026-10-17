import { Payment, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishPaymentStatusChanged } from "@/lib/sns";

// Statuses a callback or STK Query is still allowed to move forward.
// TIMED_OUT is "we stopped waiting," not "this payment is finished."
const OPENABLE: PaymentStatus[] = ["PENDING", "TIMED_OUT"];

export type CallbackOutcome = {
  checkoutRequestId: string;
  merchantRequestId?: string | null;
  resultCode: number;
  resultDesc?: string | null;
  mpesaReceiptNumber?: string | null;
};

function statusFromResultCode(resultCode: number): "PAID" | "FAILED" {
  return resultCode === 0 ? "PAID" : "FAILED";
}

// Moves a payment to PAID or FAILED at most once. A concurrent callback
// and reconcile both call this; updateMany's status guard means only
// one of them publishes.
export async function applyPaymentOutcome(
  payment: Pick<Payment, "id" | "amount" | "status">,
  outcome: {
    resultCode: number;
    resultDesc?: string | null;
    mpesaReceiptNumber?: string | null;
  }
) {
  if (payment.status !== "PENDING" && payment.status !== "TIMED_OUT") {
    return prisma.payment.findUnique({ where: { id: payment.id } });
  }

  const status = statusFromResultCode(outcome.resultCode);
  const updated = await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: OPENABLE } },
    data: {
      status,
      resultCode: outcome.resultCode,
      resultDesc: outcome.resultDesc ?? null,
      mpesaReceiptNumber: outcome.mpesaReceiptNumber ?? null,
    },
  });

  if (updated.count === 1) {
    try {
      await publishPaymentStatusChanged({
        type: "payment.status.changed",
        paymentId: payment.id,
        status,
        amount: payment.amount,
        mpesaReceiptNumber: outcome.mpesaReceiptNumber ?? undefined,
      });
    } catch (err) {
      // The row is already the source of truth. A failed announcement
      // must not fail Safaricom's ack, and must not roll the payment back.
      console.error("[payment] SNS publish failed", err);
    }
  }

  return prisma.payment.findUnique({ where: { id: payment.id } });
}

export async function storeUnmatchedCallback(outcome: CallbackOutcome) {
  await prisma.unmatchedCallback.upsert({
    where: { checkoutRequestId: outcome.checkoutRequestId },
    create: {
      checkoutRequestId: outcome.checkoutRequestId,
      merchantRequestId: outcome.merchantRequestId ?? null,
      resultCode: outcome.resultCode,
      resultDesc: outcome.resultDesc ?? null,
      mpesaReceiptNumber: outcome.mpesaReceiptNumber ?? null,
    },
    // Retries of the same callback are the same result. Keep the first.
    update: {},
  });
}

// Applies a stored callback if the payment row now exists. Deletes the
// stored row afterwards, including when the payment was already terminal,
// so a resolved callback doesn't sit in the table forever.
export async function applyStoredCallback(checkoutRequestId: string) {
  const stored = await prisma.unmatchedCallback.findUnique({
    where: { checkoutRequestId },
  });
  if (!stored) return null;

  const payment = await prisma.payment.findUnique({
    where: { checkoutRequestId },
  });
  if (!payment) return null;

  const updated = await applyPaymentOutcome(payment, {
    resultCode: stored.resultCode,
    resultDesc: stored.resultDesc,
    mpesaReceiptNumber: stored.mpesaReceiptNumber,
  });
  await prisma.unmatchedCallback.deleteMany({ where: { id: stored.id } });
  return updated;
}
