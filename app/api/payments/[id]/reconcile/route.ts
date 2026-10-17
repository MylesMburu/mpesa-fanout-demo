import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { queryStkPush } from "@/lib/daraja";
import { toStatusResponse } from "@/lib/paymentView";
import { applyPaymentOutcome } from "@/lib/resolvePayment";

// Demo stand-in for the scheduled job the talk describes. The browser
// calls this once, when it has been awaiting for a minute, instead of
// polling forever. A production version would be a cron over every
// payment still pending after a few minutes.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });

  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (payment.status === "PAID" || payment.status === "FAILED") {
    return NextResponse.json(toStatusResponse(payment));
  }

  if (!payment.checkoutRequestId) {
    await markTimedOut(id, "STK push never received a CheckoutRequestID");
    const updated = await prisma.payment.findUniqueOrThrow({ where: { id } });
    return NextResponse.json(toStatusResponse(updated));
  }

  try {
    const query = await queryStkPush(payment.checkoutRequestId);

    if (query.outcome === "unknown") {
      await markTimedOut(
        id,
        query.resultDesc ?? "No confirmation from Safaricom yet"
      );
    } else {
      await applyPaymentOutcome(payment, {
        resultCode: query.resultCode,
        resultDesc: query.resultDesc,
      });
    }
  } catch (err) {
    console.error("[reconcile] STK query failed", err);
    await markTimedOut(id, "No confirmation from Safaricom yet");
  }

  const updated = await prisma.payment.findUniqueOrThrow({ where: { id } });
  return NextResponse.json(toStatusResponse(updated));
}

// Only PENDING can time out. If a callback committed PAID or FAILED
// while the query was in flight, this matches zero rows and leaves it.
async function markTimedOut(id: string, resultDesc: string) {
  await prisma.payment.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "TIMED_OUT", resultDesc },
  });
}
