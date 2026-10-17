import { NextRequest, NextResponse } from "next/server";
import { verifySnsMessage } from "@/lib/verifySnsMessage";
import { PaymentStatusChangedEvent } from "@/lib/sns";

// Shared plumbing for every SNS HTTPS subscriber in this app. Each
// subscriber (notify, audit) gets its OWN topic subscription — SNS
// delivers a separate copy of every message to each endpoint. Neither
// subscriber knows the other exists, which is the actual point being
// demonstrated: the callback handler fans out once, and consumers can
// be added or removed without touching it.
export async function handleSnsDelivery(
  req: NextRequest,
  onEvent: (event: PaymentStatusChangedEvent) => Promise<void>
) {
  const raw = await req.json();
  const verified = await verifySnsMessage(raw);
  const messageType = req.headers.get("x-amz-sns-message-type");

  if (messageType === "SubscriptionConfirmation") {
    const subscribeUrl = (verified as { SubscribeURL: string }).SubscribeURL;
    // One-time handshake: SNS won't deliver real notifications to this
    // endpoint until you fetch this URL. Doing it here means "terraform
    // apply" (or the console) is all it takes to wire up a new
    // subscriber — no manual confirmation step.
    await fetch(subscribeUrl);
    return NextResponse.json({ ok: true, confirmed: true });
  }

  if (messageType === "Notification") {
    const message = (verified as { Message: string }).Message;
    const event = JSON.parse(message) as PaymentStatusChangedEvent;
    await onEvent(event);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: messageType });
}
