import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleSnsDelivery } from "@/lib/snsSubscriber";

// Subscriber #1: stands in for "tell the user" (SMS receipt, push
// notification, whatever). For the demo it just stamps notifiedAt —
// enough for the UI to show this subscriber lighting up independently
// of the audit subscriber below.
export async function POST(req: NextRequest) {
  return handleSnsDelivery(req, async (event) => {
    await prisma.payment.update({
      where: { id: event.paymentId },
      data: { notifiedAt: new Date() },
    });
  });
}
