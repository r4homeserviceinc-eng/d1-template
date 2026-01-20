// src/index.ts
// =====================================================
// R4 Stripe Worker + GoHighLevel Upsert Sync (CLEAN)
//
// Endpoints:
//   POST /api/create-checkout-session
//   POST /api/stripe-webhook   (signature verified, lifecycle events, GHL upsert)
//
// REQUIRED Worker Secrets (Cloudflare -> Worker -> Settings -> Variables -> Secrets):
//   STRIPE_SECRET_KEY       = sk_test_... (or sk_live_... later)
//   STRIPE_WEBHOOK_SECRET   = whsec_...
//
// REQUIRED for GoHighLevel sync (Cloudflare Secrets):
//   GHL_PRIVATE_TOKEN       = (your GoHighLevel private integration token)
//   GHL_LOCATION_ID         = (your locationId)
//
// In GoHighLevel, create these Contact custom fields (keys must match exactly):
//   r4_part_number
//   r4_service_summary
//   r4_monthly_amount
//   stripe_customer_id
//   stripe_subscription_id
//   stripe_subscription_status
//   stripe_cancel_at_period_end
//   stripe_current_period_end
//   stripe_last_invoice_id
//   stripe_last_invoice_paid_at
//   stripe_last_invoice_amount
// =====================================================

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  GHL_PRIVATE_TOKEN: string;
  GHL_LOCATION_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/api/create-checkout-session") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// =====================================================
// Create Stripe Checkout Session (monthly subscription)
// =====================================================
async function handleCreateCheckoutSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, request);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const partNumber = String(body?.partNumber ?? "").trim();
  const serviceSummary = String(body?.serviceSummary ?? "");
  const customerEmail = String(body?.customerEmail ?? "").trim();

  const monthlyAmountNum = Number(body?.monthlyAmount);
  const amountCents = Math.round(monthlyAmountNum * 100);

  if (!partNumber) return json({ error: "Missing partNumber" }, 400, request);
  if (!Number.isFinite(monthlyAmountNum) || amountCents <= 0) {
    return json({ error: "monthlyAmount must be a positive number" }, 400, request);
  }

  const params: Record<string, string> = {
    mode: "subscription",
    success_url: "https://r4homeservice.com/stripe-success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://r4homeservice.com/stripe-cancel",

    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": "R4 Home Service Plan",
    "line_items[0][price_data][product_data][description]":
      "Custom home service membership based on your selected services.",

    // SESSION metadata (easy to view in checkout session)
    "metadata[partNumber]": partNumber,
    "metadata[serviceSummary]": serviceSummary,
    "metadata[monthlyAmount]": monthlyAmountNum.toFixed(2),

    // SUBSCRIPTION metadata (best place for lifecycle)
    "subscription_data[metadata][partNumber]": partNumber,
    "subscription_data[metadata][serviceSummary]": serviceSummary,
    "subscription_data[metadata][monthlyAmount]": monthlyAmountNum.toFixed(2),
  };

  if (customerEmail) params["customer_email"] = customerEmail;

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  const stripeJson: any = await stripeRes.json().catch(() => null);
  if (!stripeRes.ok) return json({ error: "Stripe error", details: stripeJson }, 400, request);

  return json({ url: stripeJson.url }, 200, request);
}

// =====================================================
// Stripe Webhook (signature verified) + lifecycle + GHL upsert
// Handles:
//   checkout.session.completed
//   invoice.payment_succeeded
//   customer.subscription.updated
//   customer.subscription.deleted
// =====================================================
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });
  if (!env.STRIPE_SECRET_KEY) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });

  const sig = request.headers.get("Stripe-Signature");
  if (!sig) return new Response("Missing Stripe-Signature", { status: 400 });

  // Read raw bytes (best practice for signature verification)
  const rawBuf = await request.arrayBuffer();
  const rawBody = new TextDecoder("utf-8").decode(rawBuf);

  const verified = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return new Response("Invalid signature", { status: 400 });

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const type = String(event?.type || "");
  const obj = event?.data?.object;

  // -----------------------------
  // checkout.session.completed
  // -----------------------------
  if (type === "checkout.session.completed") {
    const session = obj;

    const email = String(session?.customer_details?.email || "");
    const phone = String(session?.customer_details?.phone || "");
    const name = String(session?.customer_details?.name || "");

    const customerId = session?.customer ? String(session.customer) : "";
    const subscriptionId = session?.subscription ? String(session.subscription) : "";

    const md = session?.metadata || {};
    const partNumber = String(md.partNumber || "");
    const serviceSummary = String(md.serviceSummary || "");
    const monthlyAmount = String(md.monthlyAmount || "");

    // Update Stripe Customer metadata (optional but helpful)
    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        partNumber,
        serviceSummary,
        monthlyAmount,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        lastCheckoutSession: String(session?.id || ""),
      });
    }

    // Upsert contact in GoHighLevel
    await ghlUpsertContact(env, {
      email,
      phone,
      name,
      tags: ["R4-Subscriber"],
      custom: {
        r4_part_number: partNumber,
        r4_service_summary: serviceSummary,
        r4_monthly_amount: monthlyAmount,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_subscription_status: "active",
      },
    });
  }

  // -----------------------------
  // invoice.payment_succeeded
  // -----------------------------
  if (type === "invoice.payment_succeeded") {
    const invoice = obj;

    const customerId = invoice?.customer ? String(invoice.customer) : "";
    const subscriptionId = invoice?.subscription ? String(invoice.subscription) : "";

    const invoiceId = String(invoice?.id || "");
    const amountPaidCents = Number(invoice?.amount_paid ?? 0);
    const amountPaid = (amountPaidCents / 100).toFixed(2);

    const paidAt =
      invoice?.status_transitions?.paid_at
        ? new Date(Number(invoice.status_transitions.paid_at) * 1000).toISOString()
        : new Date().toISOString();

    // Stripe customer metadata
    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        lastInvoiceId: invoiceId,
        lastInvoicePaidAt: paidAt,
        lastInvoiceAmount: amountPaid,
        stripeSubscriptionId: subscriptionId,
      });
    }

    // GHL upsert (no email/phone guaranteed on invoice events)
    await ghlUpsertContact(env, {
      email: "",
      phone: "",
      name: "",
      tags: ["R4-Subscriber"],
      custom: {
        stripe_subscription_id: subscriptionId,
        stripe_last_invoice_id: invoiceId,
        stripe_last_invoice_paid_at: paidAt,
        stripe_last_invoice_amount: amountPaid,
      },
    });
  }

  // -----------------------------
  // customer.subscription.updated
  // -----------------------------
  if (type === "customer.subscription.updated") {
    const sub = obj;

    const customerId = sub?.customer ? String(sub.customer) : "";
    const status = String(sub?.status || "");
    const cancelAtPeriodEnd = Boolean(sub?.cancel_at_period_end);

    const currentPeriodEnd =
      sub?.current_period_end
        ? new Date(Number(sub.current_period_end) * 1000).toISOString()
        : "";

    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        subscriptionStatus: status,
        cancelAtPeriodEnd: String(cancelAtPeriodEnd),
        currentPeriodEnd,
      });
    }

    await ghlUpsertContact(env, {
      email: "",
      phone: "",
      name: "",
      tags: ["R4-Subscriber"],
      custom: {
        stripe_customer_id: customerId,
        stripe_subscription_status: status,
        stripe_cancel_at_period_end: String(cancelAtPeriodEnd),
        stripe_current_period_end: currentPeriodEnd,
      },
    });
  }

  // -----------------------------
  // customer.subscription.deleted
  // -----------------------------
  if (type === "customer.subscription.deleted") {
    const sub = obj;
    const customerId = sub?.customer ? String(sub.customer) : "";

    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: "false",
      });
    }

    await ghlUpsertContact(env, {
      email: "",
      phone: "",
      name: "",
      tags: ["R4-Subscriber"],
      custom: {
        stripe_customer_id: customerId,
        stripe_subscription_status: "canceled",
      },
    });
  }

  return new Response("ok", { status: 200 });
}

// =====================================================
// GoHighLevel: Contacts Upsert
// NOTE: This uses customFields: [{ key, field_value }]
// =====================================================
async function ghlUpsertContact(
  env: Env,
  input: {
    email: string;
    phone: string;
    name: string;
    tags: string[];
    custom: Record<string, string>;
  }
) {
  // If you haven't added these secrets yet, fail softly (so Stripe webhooks still succeed)
  if (!env.GHL_PRIVATE_TOKEN || !env.GHL_LOCATION_ID) {
    console.log("GHL not configured (missing GHL_PRIVATE_TOKEN or GHL_LOCATION_ID). Skipping upsert.");
    return;
  }

  const customFields = Object.entries(input.custom)
    .map(([key, val]) => ({ key, field_value: String(val ?? "").trim() }))
    .filter((x) => x.field_value.length > 0);

  const payload: any = {
    locationId: env.GHL_LOCATION_ID,
    tags: input.tags || [],
    customFields,
    source: "stripe-webhook",
  };

  // Only include contact identifiers if present
  if (input.email?.trim()) payload.email = input.email.trim();
  if (input.phone?.trim()) payload.phone = input.phone.trim();
  if (input.name?.trim()) payload.name = input.name.trim();

  const res = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_PRIVATE_TOKEN}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    console.log("GHL upsert failed:", res.status, j);
  }
}

// =====================================================
// Stripe: Update Customer metadata
// =====================================================
async function stripeUpdateCustomerMetadata(
  stripeSecretKey: string,
  customerId: string,
  metadata: Record<string, string>
) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    const vv = String(v ?? "").trim();
    if (vv) clean[k] = vv;
  }
  if (!Object.keys(clean).length) return;

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(clean)) {
    form.append(`metadata[${k}]`, v);
  }

  const res = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    console.log("Stripe customer metadata update failed:", res.status, j);
  }
}

// =====================================================
// Stripe signature verification (v1 HMAC SHA256)
// =====================================================
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = sigHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));
  if (!tPart || !v1Parts.length) return false;

  const timestamp = tPart.slice(2);
  const signedPayload = `${timestamp}.${payload}`;
  const expected = await hmacSHA256Hex(secret, signedPayload);

  for (const v1 of v1Parts) {
    const sig = v1.slice(3);
    if (timingSafeEqualHex(sig, expected)) return true;
  }
  return false;
}

async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufferToHex(sigBuf);
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa.length !== bb.length) return false;
  let res = 0;
  for (let i = 0; i < aa.length; i++) res |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return res === 0;
}

// =====================================================
// Utility
// =====================================================
function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(obj: unknown, status: number, request: Request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}
