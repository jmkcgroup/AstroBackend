// Razorpay REST client (https://razorpay.com/docs/api/) and signature checks.
// Amounts are integer paise everywhere. The gateway is swappable so tests never hit the network.
import { createHmac } from "node:crypto";
import { env, features } from "../config/env.js";
import { AppError, serviceUnavailable } from "../lib/errors.js";
import { safeEqual } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export type RemotePayment = {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string | null;
  error_description?: string | null;
  invoice_id?: string | null;
};

export type RemoteRefund = { id: string; payment_id: string; amount: number; status: "pending" | "processed" | "failed" };

export type RemoteSubscription = {
  id: string;
  plan_id: string;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired" | "paused";
  current_start: number | null;
  current_end: number | null;
  short_url?: string;
};

export interface PaymentGateway {
  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
  fetchPayment(paymentId: string): Promise<RemotePayment>;
  capturePayment(paymentId: string, amount: number, currency: string): Promise<RemotePayment>;
  createRefund(paymentId: string, input: { amount: number; notes: Record<string, string> }): Promise<RemoteRefund>;
  createPlan(input: { period: "monthly" | "yearly"; interval: number; item: { name: string; amount: number; currency: string; description: string } }): Promise<{ id: string }>;
  createSubscription(input: { plan_id: string; total_count: number; customer_notify: 0 | 1; notes: Record<string, string> }): Promise<RemoteSubscription>;
  fetchSubscription(subscriptionId: string): Promise<RemoteSubscription>;
  cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<RemoteSubscription>;
}

const API = "https://api.razorpay.com/v1";

class RazorpayHttpGateway implements PaymentGateway {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => {
      logger.error({ err, path }, "Razorpay request failed");
      throw serviceUnavailable("The payment provider could not be reached. Please try again.");
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string; code?: string } };
    if (!res.ok) {
      logger.error({ status: res.status, path, error: json.error }, "Razorpay API error");
      // 4xx from Razorpay is a request problem we can describe; anything else is an outage.
      if (res.status >= 400 && res.status < 500) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", json.error?.description ?? "Payment provider rejected the request");
      throw serviceUnavailable("The payment provider is unavailable. Please try again.");
    }
    return json;
  }

  createOrder(input: Parameters<PaymentGateway["createOrder"]>[0]) {
    return this.call<{ id: string }>("POST", "/orders", input);
  }
  fetchPayment(id: string) {
    return this.call<RemotePayment>("GET", `/payments/${encodeURIComponent(id)}`);
  }
  capturePayment(id: string, amount: number, currency: string) {
    return this.call<RemotePayment>("POST", `/payments/${encodeURIComponent(id)}/capture`, { amount, currency });
  }
  createRefund(id: string, input: { amount: number; notes: Record<string, string> }) {
    return this.call<RemoteRefund>("POST", `/payments/${encodeURIComponent(id)}/refund`, { ...input, speed: "normal" });
  }
  createPlan(input: Parameters<PaymentGateway["createPlan"]>[0]) {
    return this.call<{ id: string }>("POST", "/plans", input);
  }
  createSubscription(input: Parameters<PaymentGateway["createSubscription"]>[0]) {
    return this.call<RemoteSubscription>("POST", "/subscriptions", input);
  }
  fetchSubscription(id: string) {
    return this.call<RemoteSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
  }
  cancelSubscription(id: string, atCycleEnd: boolean) {
    return this.call<RemoteSubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  }
}

let override: PaymentGateway | null = null;

/** Test hook: replaces the HTTP client. Pass null to restore it. */
export function setPaymentGateway(gateway: PaymentGateway | null) {
  override = gateway;
}

export function gateway(): PaymentGateway {
  if (override) return override;
  if (!features.razorpay) throw serviceUnavailable("Online payment is not configured yet");
  return new RazorpayHttpGateway(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET!);
}

export const paymentsEnabled = () => Boolean(override) || features.razorpay;

// ── Signatures ────────────────────────────────────────────────

const hmac = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

/** Standard Checkout: HMAC-SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  return safeEqual(hmac(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
}

/** Subscription checkout: HMAC-SHA256(payment_id + "|" + subscription_id, key_secret). */
export function verifySubscriptionSignature(paymentId: string, subscriptionId: string, signature: string) {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  return safeEqual(hmac(env.RAZORPAY_KEY_SECRET, `${paymentId}|${subscriptionId}`), signature);
}

/** Webhooks: HMAC-SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  return safeEqual(hmac(env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}
