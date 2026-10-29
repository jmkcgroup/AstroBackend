// In-memory stand-in for Razorpay. It signs callbacks with the test secrets exactly as Razorpay
// does, so the real verification code runs; only the network calls are replaced.
import { createHmac } from "node:crypto";
import type { PaymentGateway, RemotePayment, RemoteRefund, RemoteSubscription } from "../src/payments/razorpay.js";

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
export const signCheckout = (data: string) => hmac(process.env.RAZORPAY_KEY_SECRET!, data);
export const signWebhook = (body: string) => hmac(process.env.RAZORPAY_WEBHOOK_SECRET!, body);

export class FakeGateway implements PaymentGateway {
  orders = new Map<string, { amount: number; currency: string; receipt: string }>();
  payments = new Map<string, RemotePayment>();
  refunds: RemoteRefund[] = [];
  subscriptions = new Map<string, RemoteSubscription>();
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_T${Date.now().toString(36)}${++this.seq}`;
  }

  async createOrder(input: { amount: number; currency: string; receipt: string }) {
    const id = this.id("order");
    this.orders.set(id, input);
    return { id };
  }

  /** Simulates the customer completing Checkout; returns what the browser posts back. */
  pay(orderId: string, opts: { status?: RemotePayment["status"]; amount?: number } = {}) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    const payment: RemotePayment = {
      id: this.id("pay"),
      order_id: orderId,
      amount: opts.amount ?? order.amount,
      currency: order.currency,
      status: opts.status ?? "captured",
      method: "upi",
      error_description: opts.status === "failed" ? "Payment declined by bank" : null,
    };
    this.payments.set(payment.id, payment);
    return { payment, callback: { razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: signCheckout(`${orderId}|${payment.id}`) } };
  }

  async fetchPayment(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new Error(`unknown payment ${id}`);
    return { ...p };
  }

  async capturePayment(id: string) {
    const p = this.payments.get(id)!;
    p.status = "captured";
    return { ...p };
  }

  async createRefund(paymentId: string, input: { amount: number }) {
    const r: RemoteRefund = { id: this.id("rfnd"), payment_id: paymentId, amount: input.amount, status: "processed" };
    this.refunds.push(r);
    return r;
  }

  async createPlan() {
    return { id: this.id("plan") };
  }

  async createSubscription(input: { plan_id: string }) {
    const s: RemoteSubscription = { id: this.id("sub"), plan_id: input.plan_id, status: "created", current_start: null, current_end: null };
    this.subscriptions.set(s.id, s);
    return { ...s };
  }

  /** Simulates the first charge of a subscription; returns the checkout callback and the charge. */
  activate(subscriptionId: string, amount: number) {
    const s = this.subscriptions.get(subscriptionId)!;
    const now = Math.floor(Date.now() / 1000);
    Object.assign(s, { status: "active", current_start: now, current_end: now + 30 * 86_400 });
    const payment: RemotePayment = { id: this.id("pay"), order_id: this.id("order"), amount, currency: "INR", status: "captured", method: "card", invoice_id: this.id("inv") };
    this.payments.set(payment.id, payment);
    return {
      payment,
      callback: { razorpay_payment_id: payment.id, razorpay_subscription_id: s.id, razorpay_signature: signCheckout(`${payment.id}|${s.id}`) },
    };
  }

  async fetchSubscription(id: string) {
    return { ...this.subscriptions.get(id)! };
  }

  async cancelSubscription(id: string, atCycleEnd: boolean) {
    const s = this.subscriptions.get(id)!;
    if (!atCycleEnd) s.status = "cancelled";
    return { ...s };
  }
}
