import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { initiateStkPush } from "@/lib/daraja";
import { applyStoredCallback } from "@/lib/resolvePayment";

const IDEMPOTENCY_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Step 1 of the flow: the ONLY synchronous part of this whole system.
// The pending row is written before Daraja is called. Everything after
// the CheckoutRequestID is attached — did it succeed, did the user
// cancel, did Safaricom time out — arrives later, out of band.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { phoneNumber, amount, idempotencyKey } = body as {
    phoneNumber?: string;
    amount?: number;
    idempotencyKey?: string;
  };

  if (!phoneNumber || !/^2547\d{8}$/.test(phoneNumber)) {
    return NextResponse.json(
      { error: "Phone number must be in 2547XXXXXXXX format" },
      { status: 400 }
    );
  }
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    return NextResponse.json({ error: "Amount must be a positive integer" }, {
      status: 400,
    });
  }
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return NextResponse.json(
      { error: "idempotencyKey must be a UUID" },
      { status: 400 }
    );
  }

  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callbackSecret = process.env.MPESA_CALLBACK_SECRET;
  if (!baseUrl || !callbackSecret) {
    return NextResponse.json(
      { error: "Server misconfigured: PUBLIC_BASE_URL / MPESA_CALLBACK_SECRET not set" },
      { status: 500 }
    );
  }

  try {
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey },
    });

    // Same click, already accepted by Daraja. Do not send a second prompt.
    if (existing?.checkoutRequestId) {
      return NextResponse.json({ paymentId: existing.id });
    }

    let payment = existing;
    if (!payment) {
      try {
        payment = await prisma.payment.create({
          data: {
            phoneNumber,
            amount,
            idempotencyKey,
            status: "PENDING",
          },
        });
      } catch (err) {
        if (!isUniqueConflict(err)) throw err;
        const raced = await prisma.payment.findUnique({
          where: { idempotencyKey },
        });
        if (!raced) throw err;
        if (raced.checkoutRequestId) {
          return NextResponse.json({ paymentId: raced.id });
        }
        payment = raced;
      }
    }

    const stk = await initiateStkPush({
      phoneNumber,
      amount,
      accountReference: "RenderConDemo",
      transactionDesc: "RenderCon Kenya async-payment demo",
      callbackUrl: `${baseUrl}/api/mpesa/callback/${callbackSecret}`,
    });

    if (String(stk.ResponseCode) !== "0" || !stk.CheckoutRequestID) {
      throw new Error(
        stk.ResponseDescription || stk.CustomerMessage || "STK push rejected"
      );
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        merchantRequestId: stk.MerchantRequestID,
        checkoutRequestId: stk.CheckoutRequestID,
      },
    });

    // The callback may have landed while we were still talking to Daraja.
    await applyStoredCallback(stk.CheckoutRequestID);

    return NextResponse.json({ paymentId: payment.id });
  } catch (err) {
    // No CheckoutRequestID was stored, so the same key can try Daraja again.
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STK push failed" },
      { status: 502 }
    );
  }
}

function isUniqueConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
