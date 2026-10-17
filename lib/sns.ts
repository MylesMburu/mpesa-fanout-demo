import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

// One topic, multiple independent subscribers (see app/api/sns/*). This
// is the fan-out: the callback handler doesn't know or care who's
// listening — it just publishes "this payment changed state."
const client = new SNSClient({ region: process.env.AWS_REGION || "eu-west-1" });

export type PaymentStatusChangedEvent = {
  type: "payment.status.changed";
  paymentId: string;
  status: "PAID" | "FAILED";
  amount: number;
  mpesaReceiptNumber?: string;
};

export async function publishPaymentStatusChanged(
  event: PaymentStatusChangedEvent
) {
  const topicArn = process.env.SNS_PAYMENT_TOPIC_ARN;
  if (!topicArn) {
    // Fails loudly rather than silently skipping the fan-out — during
    // the talk you want a missing env var to be obvious, not a payment
    // that quietly never notifies anyone.
    throw new Error("Missing SNS_PAYMENT_TOPIC_ARN");
  }

  await client.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(event),
      MessageAttributes: {
        eventType: { DataType: "String", StringValue: event.type },
      },
    })
  );
}
