import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleSnsDelivery } from "@/lib/snsSubscriber";

// Subscriber #2: an independent compliance/audit trail. It has no idea
// subscriber #1 (notify) exists, and vice versa — proving that out.
export async function POST(req: NextRequest) {
  return handleSnsDelivery(req, async (event) => {
    await prisma.$transaction([
      prisma.auditLog.create({
        data: {
          paymentId: event.paymentId,
          event: "payment.status.changed",
          detail: `status=${event.status} amount=${event.amount} receipt=${
            event.mpesaReceiptNumber ?? "n/a"
          }`,
        },
      }),
      prisma.payment.update({
        where: { id: event.paymentId },
        data: { auditedAt: new Date() },
      }),
    ]);
  });
}
