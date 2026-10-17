"use client";

import { useEffect, useRef, useState } from "react";
import type { PaymentStatusResponse } from "@/lib/paymentView";

type PaymentUiState =
  | { status: "idle" }
  | { status: "initiating" }
  | { status: "awaiting"; paymentId: string; snapshot: PaymentStatusResponse | null }
  | {
      status: "paid";
      paymentId: string;
      amount: number;
      receipt: string | null;
      snapshot: PaymentStatusResponse;
    }
  | {
      status: "failed";
      paymentId: string;
      reason: string;
      snapshot: PaymentStatusResponse;
    }
  | { status: "timed_out"; paymentId: string; snapshot: PaymentStatusResponse | null };

type Step = {
  label: string;
  done: (snapshot: PaymentStatusResponse | null, paymentId: string | null) => boolean;
};

const FAST_POLL_MS = 1500;
const SUBSCRIBER_GRACE_MS = 8000;
const AWAIT_TIMEOUT_MS = 60_000;
const SLOW_POLL_MS = 5000;
const SLOW_POLL_WINDOW_MS = 60_000;

// This IS a real sequence, so numbering it is earning its keep rather
// than decorating — each row only lights up once that part of the
// system has actually run, live, during the talk.
const STEPS: Step[] = [
  { label: "STK push sent to Daraja", done: (_s, id) => id !== null },
  {
    label: "Waiting for the customer to confirm on their phone…",
    done: (s) => s?.status === "paid" || s?.status === "failed",
  },
  {
    label: "Callback received, idempotency-checked, published to SNS",
    done: (s) => Boolean(s?.steps.callbackReceived),
  },
  { label: "Notify subscriber processed", done: (s) => Boolean(s?.steps.notified) },
  { label: "Audit subscriber processed", done: (s) => Boolean(s?.steps.audited) },
];

function paymentIdOf(ui: PaymentUiState): string | null {
  return ui.status === "idle" || ui.status === "initiating" ? null : ui.paymentId;
}

function snapshotOf(ui: PaymentUiState): PaymentStatusResponse | null {
  return ui.status === "idle" || ui.status === "initiating" ? null : ui.snapshot;
}

export default function PaymentDemo() {
  const [ui, setUi] = useState<PaymentUiState>({ status: "idle" });
  const [phoneNumber, setPhoneNumber] = useState("2547");
  const [amount, setAmount] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const slowPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const awaitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const phaseRef = useRef<PaymentUiState["status"]>("idle");
  const mountedRef = useRef(true);

  function stopFastPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function stopSlowPoll() {
    if (slowPollRef.current) clearInterval(slowPollRef.current);
    slowPollRef.current = null;
  }

  function clearAwaitTimeout() {
    if (awaitTimeoutRef.current) clearTimeout(awaitTimeoutRef.current);
    awaitTimeoutRef.current = null;
  }

  function clearTimers() {
    stopFastPoll();
    stopSlowPoll();
    clearAwaitTimeout();
  }

  function applySnapshot(
    paymentId: string,
    snapshot: PaymentStatusResponse
  ): "pending" | "paid" | "failed" | "timed_out" {
    if (snapshot.status === "paid") {
      phaseRef.current = "paid";
      setUi({
        status: "paid",
        paymentId,
        amount: snapshot.amount,
        receipt: snapshot.receiptNumber,
        snapshot,
      });
      return "paid";
    }
    if (snapshot.status === "failed") {
      phaseRef.current = "failed";
      setUi({
        status: "failed",
        paymentId,
        reason: snapshot.reason ?? "Payment failed or was cancelled",
        snapshot,
      });
      return "failed";
    }
    // Once we've said timed_out, a still-pending poll must not walk
    // the label backwards to awaiting. A late paid/failed still wins,
    // because those branches returned above.
    if (snapshot.status === "timed_out" || phaseRef.current === "timed_out") {
      phaseRef.current = "timed_out";
      setUi({ status: "timed_out", paymentId, snapshot });
      return "timed_out";
    }
    phaseRef.current = "awaiting";
    setUi({ status: "awaiting", paymentId, snapshot });
    return "pending";
  }

  async function fetchStatus(paymentId: string): Promise<PaymentStatusResponse | null> {
    const res = await fetch(`/api/payments/${paymentId}/status`);
    if (!res.ok) return null;
    return (await res.json()) as PaymentStatusResponse;
  }

  function startFastPoll(paymentId: string, graceOnly = false) {
    stopFastPoll();
    let terminalSince: number | null = graceOnly ? Date.now() : null;

    const tick = async () => {
      const snapshot = await fetchStatus(paymentId);
      if (!mountedRef.current || !snapshot) return;

      const kind = applySnapshot(paymentId, snapshot);
      if (kind === "timed_out") {
        stopFastPoll();
        clearAwaitTimeout();
        startSlowPoll(paymentId);
        return;
      }
      if (kind !== "paid" && kind !== "failed") return;

      if (terminalSince === null) terminalSince = Date.now();
      clearAwaitTimeout();
      const subscribersDone = snapshot.steps.notified && snapshot.steps.audited;
      const graceElapsed = Date.now() - terminalSince >= SUBSCRIBER_GRACE_MS;
      // The result is already on screen. This extra window only exists
      // so notify/audit can still light up. It always ends.
      if (subscribersDone || graceElapsed) stopFastPoll();
    };

    void tick();
    pollRef.current = setInterval(() => {
      void tick();
    }, FAST_POLL_MS);
  }

  function startSlowPoll(paymentId: string) {
    stopSlowPoll();
    const started = Date.now();
    slowPollRef.current = setInterval(async () => {
      if (Date.now() - started >= SLOW_POLL_WINDOW_MS) {
        stopSlowPoll();
        return;
      }
      const snapshot = await fetchStatus(paymentId);
      if (!mountedRef.current || !snapshot) return;
      const kind = applySnapshot(paymentId, snapshot);
      if (kind === "paid" || kind === "failed") {
        stopSlowPoll();
        startFastPoll(paymentId, true);
      }
    }, SLOW_POLL_MS);
  }

  async function onAwaitTimeout(paymentId: string) {
    if (!mountedRef.current || phaseRef.current !== "awaiting") return;
    stopFastPoll();

    try {
      const res = await fetch(`/api/payments/${paymentId}/reconcile`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("reconcile failed");
      const snapshot = (await res.json()) as PaymentStatusResponse;
      if (!mountedRef.current) return;
      const kind = applySnapshot(paymentId, snapshot);
      if (kind === "paid" || kind === "failed") {
        startFastPoll(paymentId, true);
        return;
      }
      if (kind === "pending") {
        phaseRef.current = "timed_out";
        setUi({ status: "timed_out", paymentId, snapshot });
      }
    } catch (err) {
      console.error(err);
      if (!mountedRef.current) return;
      phaseRef.current = "timed_out";
      setUi({ status: "timed_out", paymentId, snapshot: null });
    }

    startSlowPoll(paymentId);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
    };
    // clearTimers only touches refs. The cleanup should run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    clearTimers();

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    phaseRef.current = "initiating";
    setUi({ status: "initiating" });

    try {
      const res = await fetch("/api/mpesa/stk-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber,
          amount,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (!mountedRef.current) return;

      phaseRef.current = "awaiting";
      setUi({ status: "awaiting", paymentId: data.paymentId, snapshot: null });
      startFastPoll(data.paymentId);
      awaitTimeoutRef.current = setTimeout(() => {
        void onAwaitTimeout(data.paymentId);
      }, AWAIT_TIMEOUT_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      phaseRef.current = "idle";
      setUi({ status: "idle" });
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      submittingRef.current = false;
    }
  }

  function reset() {
    clearTimers();
    submittingRef.current = false;
    idempotencyKeyRef.current = null;
    phaseRef.current = "idle";
    setUi({ status: "idle" });
    setError(null);
    setAmount(1);
  }

  const paymentId = paymentIdOf(ui);
  const snapshot = snapshotOf(ui);
  const stateColor =
    ui.status === "paid"
      ? "text-accent-paid"
      : ui.status === "failed"
        ? "text-accent-failed"
        : ui.status === "timed_out" || ui.status === "awaiting" || ui.status === "initiating"
          ? "text-accent-pending"
          : "text-text-muted";

  return (
    <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6">
      <p className="text-sm text-text-muted">RenderCon Kenya demo</p>
      <h1 className="mt-1 text-xl font-medium text-text">Pay with M-Pesa</h1>
      <p className={`mt-3 font-mono text-sm ${stateColor}`}>state: {ui.status}</p>

      {ui.status === "idle" && (
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm text-text-muted" htmlFor="phone">
              Phone number
            </label>
            <input
              id="phone"
              required
              pattern="2547\d{8}"
              title="Format: 2547XXXXXXXX"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="2547XXXXXXXX"
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-text outline-none focus:border-accent-paid"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-text-muted" htmlFor="amount">
              Amount (KES)
            </label>
            <input
              id="amount"
              type="number"
              min={1}
              required
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-text outline-none focus:border-accent-paid"
            />
          </div>
          {error && <p className="text-sm text-accent-failed">{error}</p>}
          <button
            type="submit"
            className="w-full rounded-md bg-accent-paid px-4 py-2 font-medium text-[#0f1417] transition hover:opacity-90 disabled:opacity-50"
          >
            Send STK push
          </button>
        </form>
      )}

      {ui.status !== "idle" && (
        <div className="mt-6">
          <ol className="space-y-3 font-mono text-sm">
            {STEPS.map((step, i) => {
              const done = step.done(snapshot, paymentId);
              const isFailed = snapshot?.status === "failed" && i === 1;
              return (
                <li key={step.label} className="flex items-start gap-3">
                  <span
                    className={
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs " +
                      (isFailed
                        ? "border-accent-failed text-accent-failed"
                        : done
                          ? "border-accent-paid text-accent-paid"
                          : "border-border text-text-muted")
                    }
                  >
                    {isFailed ? "×" : done ? "✓" : i + 1}
                  </span>
                  <span className={done || isFailed ? "text-text" : "text-text-muted"}>
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ol>

          {ui.status === "paid" && (
            <div className="mt-5 rounded-md border border-accent-paid/40 bg-accent-paid/10 px-4 py-3">
              <p className="font-medium text-accent-paid">Paid — KES {ui.amount}</p>
              {ui.receipt && (
                <p className="font-mono text-sm text-text-muted">Receipt {ui.receipt}</p>
              )}
            </div>
          )}

          {ui.status === "failed" && (
            <div className="mt-5 rounded-md border border-accent-failed/40 bg-accent-failed/10 px-4 py-3">
              <p className="font-medium text-accent-failed">{ui.reason}</p>
            </div>
          )}

          {ui.status === "timed_out" && (
            <div className="mt-5 rounded-md border border-accent-pending/40 bg-accent-pending/10 px-4 py-3">
              <p className="font-medium text-accent-pending">
                We haven&apos;t confirmed your payment yet.
              </p>
              <p className="mt-1 text-sm text-text-muted">
                If you were charged, this page will update. Please don&apos;t pay again.
              </p>
            </div>
          )}

          {ui.status !== "initiating" && (
            <button
              onClick={reset}
              className="mt-5 text-sm text-text-muted underline decoration-border underline-offset-4 hover:text-text"
            >
              Run again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
