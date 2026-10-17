import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseCallbackMetadata, StkCallbackBody } from "@/lib/daraja";
import {
  applyPaymentOutcome,
  applyStoredCallback,
  storeUnmatchedCallback,
} from "@/lib/resolvePayment";

// Step 2: this is Safaricom calling YOU, whenever it feels like it.
// No auth header, no HMAC signature — Daraja doesn't offer one. So
// "verification" here is layered instead of cryptographic:
//
//   1. The URL itself is a high-entropy secret (the [secret] segment) —
//      an outsider can't discover this endpoint to spam it.
//   2. Optional IP allowlist (defense in depth; Safaricom's ranges can
//      change without notice, so this only WARNS unless you opt in).
//   3. The real check: does this CheckoutRequestID correspond to a
//      payment WE initiated that isn't already PAID or FAILED? If it's
//      already resolved, we ack and do nothing. If the row doesn't
//      exist yet, we store the callback and apply it once the id lands.
const SAFARICOM_IP_ALLOWLIST = (process.env.MPESA_IP_ALLOWLIST || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

function callerIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

function accepted() {
  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ secret: string }> }
) {
  const { secret } = await params;
  if (secret !== process.env.MPESA_CALLBACK_SECRET) {
    // Deliberately vague — don't confirm/deny this is even the right
    // shape of endpoint to a caller who guessed wrong.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (SAFARICOM_IP_ALLOWLIST.length > 0) {
    const ip = callerIp(req);
    if (!ip || !SAFARICOM_IP_ALLOWLIST.includes(ip)) {
      console.warn(`[mpesa-callback] unexpected source IP: ${ip}`);
      // Warn, don't reject — see comment above on why this is soft.
    }
  }

  const body = (await req.json()) as StkCallbackBody;
  const result = parseCallbackMetadata(body);

  if (!result.checkoutRequestId) {
    return accepted();
  }

  const payment = await prisma.payment.findUnique({
    where: { checkoutRequestId: result.checkoutRequestId },
  });

  if (!payment) {
    await storeUnmatchedCallback({
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
      mpesaReceiptNumber: result.mpesaReceiptNumber,
    });
    // The stk-push route may have attached this id between the read
    // above and the store. Apply now if it did.
    await applyStoredCallback(result.checkoutRequestId);
    return accepted();
  }

  if (payment.status === "PAID" || payment.status === "FAILED") {
    return accepted();
  }

  await applyPaymentOutcome(payment, {
    resultCode: result.resultCode,
    resultDesc: result.resultDesc,
    mpesaReceiptNumber: result.mpesaReceiptNumber,
  });

  return accepted();
}
