import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toStatusResponse } from "@/lib/paymentView";

// The BFF payoff: this is the ONLY shape the frontend ever sees. It
// never touches Daraja's stkCallback envelope, never sees ResultCode
// numbers, never knows SNS or idempotency exist. The frontend just
// polls this and renders. Everything upstream of this route can change
// — new payment provider, new fan-out mechanism — without a single
// frontend line moving.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id } });

  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(toStatusResponse(payment));
}
