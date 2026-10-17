// Thin wrapper around the three Daraja calls this demo needs:
// OAuth token, STK Push (initiate), and password generation.
//
// Sandbox base URL and shortcode are Safaricom's public test values —
// see https://developer.safaricom.co.ke/test_credentials. Swap
// DARAJA_BASE_URL and DARAJA_SHORTCODE for production values when you
// go live; nothing else in this file changes.

const DARAJA_BASE_URL =
  process.env.DARAJA_BASE_URL || "https://sandbox.safaricom.co.ke";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export async function getAccessToken(): Promise<string> {
  const consumerKey = requireEnv("DARAJA_CONSUMER_KEY");
  const consumerSecret = requireEnv("DARAJA_CONSUMER_SECRET");
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    "base64"
  );

  const res = await fetch(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!res.ok) {
    throw new Error(`Daraja OAuth failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function darajaTimestamp(): string {
  // Daraja wants YYYYMMDDHHmmss, in the account's local time (Kenya).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function generatePassword(shortcode: string, passkey: string, timestamp: string) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

export interface StkPushResult {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export async function initiateStkPush(params: {
  phoneNumber: string; // 2547XXXXXXXX
  amount: number;
  accountReference: string;
  transactionDesc: string;
  callbackUrl: string;
}): Promise<StkPushResult> {
  const shortcode = process.env.DARAJA_SHORTCODE || "174379";
  const passkey = requireEnv("DARAJA_PASSKEY");
  const accessToken = await getAccessToken();

  const timestamp = darajaTimestamp();
  const password = generatePassword(shortcode, passkey, timestamp);

  const res = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: params.amount,
      PartyA: params.phoneNumber,
      PartyB: shortcode,
      PhoneNumber: params.phoneNumber,
      CallBackURL: params.callbackUrl,
      AccountReference: params.accountReference,
      TransactionDesc: params.transactionDesc,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`STK push failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data as StkPushResult;
}

export type StkQueryOutcome =
  | { outcome: "paid" | "failed"; resultCode: number; resultDesc?: string }
  | { outcome: "unknown"; resultDesc?: string };

// Daraja uses 4999 while the handset prompt is still open. That is not
// a payment result — the customer hasn't decided yet.
const STILL_PROCESSING_RESULT_CODES = new Set([4999]);

// STK Push Query: ask Safaricom what happened when the callback never
// came. A missing or "still processing" result is `unknown`, which the
// caller turns into our own TIMED_OUT. A real ResultCode is decisive.
export async function queryStkPush(
  checkoutRequestId: string
): Promise<StkQueryOutcome> {
  const shortcode = process.env.DARAJA_SHORTCODE || "174379";
  const passkey = requireEnv("DARAJA_PASSKEY");
  const accessToken = await getAccessToken();
  const timestamp = darajaTimestamp();
  const password = generatePassword(shortcode, passkey, timestamp);

  const res = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    ResultCode?: string | number;
    ResultDesc?: string;
    errorMessage?: string;
    errorCode?: string;
    ResponseDescription?: string;
  };

  const described =
    data.ResultDesc || data.errorMessage || data.ResponseDescription || "";
  const stillProcessing =
    /still under processing|being processed/i.test(described) ||
    data.errorCode === "500.001.1001";

  if (
    data.ResultCode === undefined ||
    data.ResultCode === null ||
    data.ResultCode === ""
  ) {
    return { outcome: "unknown", resultDesc: described || undefined };
  }

  const resultCode = Number(data.ResultCode);
  if (
    Number.isNaN(resultCode) ||
    STILL_PROCESSING_RESULT_CODES.has(resultCode) ||
    stillProcessing
  ) {
    return { outcome: "unknown", resultDesc: described || undefined };
  }

  return {
    outcome: resultCode === 0 ? "paid" : "failed",
    resultCode,
    resultDesc: data.ResultDesc,
  };
}

// Shape Safaricom POSTs to your CallBackURL. On a successful payment,
// CallbackMetadata carries the receipt details as a flat Name/Value list
// rather than a normal object — this type captures that as Daraja sends
// it, and lib/parseCallback.ts turns it into something usable.
//
// Note: as of March 2026 Safaricom masks PhoneNumber in this payload
// (e.g. "254722000***") — don't rely on it for anything but display.
export interface StkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}

export function parseCallbackMetadata(body: StkCallbackBody) {
  const cb = body.Body.stkCallback;
  const items = cb.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i) => i.Name === name)?.Value;

  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    amount: get("Amount") as number | undefined,
    mpesaReceiptNumber: get("MpesaReceiptNumber") as string | undefined,
    transactionDate: get("TransactionDate") as number | undefined,
    phoneNumber: get("PhoneNumber") as string | number | undefined,
  };
}
