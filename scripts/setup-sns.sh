#!/usr/bin/env bash
# Run this locally (AWS CLI + credentials configured) AFTER you've
# deployed and have a real PUBLIC_BASE_URL. Creates one SNS topic and
# subscribes both fan-out consumers to it via HTTPS.
#
# Usage: PUBLIC_BASE_URL=https://your-app.vercel.app ./scripts/setup-sns.sh

set -euo pipefail

: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL first, e.g. https://your-app.vercel.app}"
REGION="${AWS_REGION:-eu-west-1}"

echo "Creating SNS topic..."
TOPIC_ARN=$(aws sns create-topic --name rendercon-payment-events \
  --region "$REGION" --query TopicArn --output text)
echo "Topic ARN: $TOPIC_ARN"

echo "Subscribing notify endpoint..."
aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol https \
  --notification-endpoint "$PUBLIC_BASE_URL/api/sns/notify" \
  --region "$REGION"

echo "Subscribing audit endpoint..."
aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol https \
  --notification-endpoint "$PUBLIC_BASE_URL/api/sns/audit" \
  --region "$REGION"

echo
echo "Done. Each subscribe call above triggers SNS to POST a"
echo "SubscriptionConfirmation to that endpoint — the app auto-confirms it"
echo "(see lib/snsSubscriber.ts), so no manual click-through needed."
echo
echo "Set this in your env:"
echo "SNS_PAYMENT_TOPIC_ARN=$TOPIC_ARN"
