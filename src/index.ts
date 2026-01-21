// src/index.ts
// =====================================================
// R4 Stripe Worker + GoHighLevel Upsert Sync (ROBUST + BETTER LOGS)
// UPDATED:
//  - Accept phone + smsOptIn from selector tool
//  - Store phone + smsOptIn in Stripe metadata (session + subscription)
//  - Use metadata phone if Stripe checkout doesn't provide it
//  - Add SMS-OptIn tag + custom fields to GHL
//
// Endpoints:
//   POST /api/create-checkout-session
//   POST /api/stripe-webhook
//
// REQUIRED Worker Secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//
// OPTIONAL (for GHL sync):
//   GHL_PRIVATE_TOKEN
//   GHL_LOCATION_ID
//
// In GoHighLevel, create these Contact custom fields (keys must match exactly):
//   r4_part_number
//   r4_service_summary
//   r4_monthly_amount
//   stripe_customer_id
//   stripe_subscription_id
//   stripe_subscription_status
//   r4_customer_phone
//   r4_sms_opt_in
//   r4_sms_opt_in_ts
// =====================================================

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  GHL_PRIVATE_TOKEN?: string;
  GHL_LOCATION_ID?: string;
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

    if (url.pathname === "/api/create-billing-portal") {
  return handleCreateBillingPortal(request, env);
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

  // NEW: phone + sms opt-in from selector
  // phone is expected in E.164 like +13525551234 (your selector normalizes)
  const selectorPhone = String(body?.phone ?? "").trim();
  const smsOptInBool = Boolean(body?.smsOptIn);
  const smsOptIn = smsOptInBool ? "yes" : "no";
  const smsOptInTs = new Date().toISOString();

  const monthlyAmountNum = Number(body?.monthlyAmount);
  const amountCents = Math.round(monthlyAmountNum * 100);

  if (!partNumber) return json({ error: "Missing partNumber" }, 400, request);
  if (!Number.isFinite(monthlyAmountNum) || amountCents <= 0) {
    return json({ error: "monthlyAmount must be a positive number" }, 400, request);
  }

  // Optional: require phone if you want to enforce it server-side too
  // (selector already enforces, but this prevents direct calls without phone)
  if (!selectorPhone) {
    return json({ error: "Missing phone" }, 400, request);
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

    // NOTE:
    // We are NOT using Stripe's phone_number_collection here because it shows
    // the "save my info for faster checkout" Link UI.
    // Phone is collected on the selector and stored in metadata.

    // SESSION metadata
    "metadata[partNumber]": partNumber,
    "metadata[serviceSummary]": serviceSummary,
    "metadata[monthlyAmount]": monthlyAmountNum.toFixed(2),

    // NEW: store selector phone + sms consent on session metadata
    "metadata[selectorPhone]": selectorPhone,
    "metadata[smsOptIn]": smsOptIn,
    "metadata[smsOptInTs]": smsOptInTs,

    // SUBSCRIPTION metadata
    "subscription_data[metadata][partNumber]": partNumber,
    "subscription_data[metadata][serviceSummary]": serviceSummary,
    "subscription_data[metadata][monthlyAmount]": monthlyAmountNum.toFixed(2),

    // NEW: store selector phone + sms consent on subscription metadata too
    "subscription_data[metadata][selectorPhone]": selectorPhone,
    "subscription_data[metadata][smsOptIn]": smsOptIn,
    "subscription_data[metadata][smsOptInTs]": smsOptInTs,
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
  if (!stripeRes.ok) {
    console.log("Stripe create session failed:", stripeRes.status, stripeJson);
    return json({ error: "Stripe error", details: stripeJson }, 400, request);
  }

  return json({ url: stripeJson.url }, 200, request);
}
async function handleCreateBillingPortal(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, request);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email) return json({ error: "Missing email" }, 400, request);

  // Find Stripe customer by email
  const listRes = await fetch(
    "https://api.stripe.com/v1/customers?limit=1&email=" + encodeURIComponent(email),
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  const listJson: any = await listRes.json().catch(() => null);
  if (!listRes.ok) return json({ error: "Stripe error", details: listJson }, 400, request);

  const customerId = listJson?.data?.[0]?.id ? String(listJson.data[0].id) : "";
  if (!customerId) return json({ error: "No Stripe customer found for that email." }, 404, request);

  // Create Billing Portal session
  const form = new URLSearchParams();
  form.set("customer", customerId);
  form.set("return_url", "https://r4homeservice.com/manage");

  const portalRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const portalJson: any = await portalRes.json().catch(() => null);
  if (!portalRes.ok) return json({ error: "Stripe error", details: portalJson }, 400, request);

  return json({ url: portalJson.url }, 200, request);
}

// =====================================================
// Stripe Webhook (signature verified) + lifecycle + GHL upsert
// =====================================================
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });
  if (!env.STRIPE_SECRET_KEY) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });

  const sig = request.headers.get("Stripe-Signature");
  if (!sig) return new Response("Missing Stripe-Signature", { status: 400 });

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

  console.log("Stripe event:", type);

  if (type === "checkout.session.completed") {
    const session = obj;

    const customerId = session?.customer ? String(session.customer) : "";
    const subscriptionId = session?.subscription ? String(session.subscription) : "";

    const md = session?.metadata || {};
    const partNumber = String(md.partNumber || "");
    const serviceSummary = String(md.serviceSummary || "");
    const monthlyAmount = String(md.monthlyAmount || "");

    // NEW: pull phone + sms consent from metadata
    const selectorPhone = String(md.selectorPhone || "").trim();
    const smsOptIn = String(md.smsOptIn || "").trim();       // "yes" | "no"
    const smsOptInTs = String(md.smsOptInTs || "").trim();   // ISO string

    let email = String(
      session?.customer_details?.email ||
      session?.customer_email ||
      session?.customer_details?.email_address ||
      ""
    ).trim();

    // Use Stripe phone if present, else fall back to selector metadata phone
    let phone = String(session?.customer_details?.phone || "").trim();
    if (!phone && selectorPhone) phone = selectorPhone;

    let name = String(session?.customer_details?.name || "").trim();

    // If missing email/name still, try Stripe customer
    if ((!email || !name) && customerId) {
      const cust = await stripeGetCustomer(env.STRIPE_SECRET_KEY, customerId);
      if (!email) email = String(cust?.email || "").trim();
      if (!name) name = String(cust?.name || "").trim();
      if (!phone) phone = String(cust?.phone || "").trim(); // last resort
    }

    // Update Stripe Customer metadata
    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        partNumber,
        serviceSummary,
        monthlyAmount,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        lastCheckoutSession: String(session?.id || ""),

        // NEW
        selectorPhone: selectorPhone || phone,
        smsOptIn,
        smsOptInTs,
      });
    }

    // Build tags for GHL
    const tags = ["R4-Subscriber"];
    if (smsOptIn === "yes") tags.push("SMS-OptIn");

    // Upsert contact in GoHighLevel (requires email or phone)
    if (!email && !phone) {
      console.log("Skipping GHL upsert: no email/phone available from Stripe session/customer.");
    } else {
      await ghlUpsertContact(env, {
        email,
        phone,
        name,
        tags,
        custom: {
          r4_part_number: partNumber,
          r4_service_summary: serviceSummary,
          r4_monthly_amount: monthlyAmount,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_subscription_status: "active",

          // NEW custom fields
          r4_customer_phone: phone,
          r4_sms_opt_in: smsOptIn,
          r4_sms_opt_in_ts: smsOptInTs,
        },
      });
    }
  }

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

    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        lastInvoiceId: invoiceId,
        lastInvoicePaidAt: paidAt,
        lastInvoiceAmount: amountPaid,
        stripeSubscriptionId: subscriptionId,
      });
    }

    console.log("Invoice paid:", { invoiceId, amountPaid, subscriptionId, customerId });
  }

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

    console.log("Subscription updated:", { customerId, status, cancelAtPeriodEnd, currentPeriodEnd });
  }

  if (type === "customer.subscription.deleted") {
    const sub = obj;
    const customerId = sub?.customer ? String(sub.customer) : "";

    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: "false",
      });
    }

    console.log("Subscription deleted:", { customerId });
  }

  return new Response("ok", { status: 200 });
}

// =====================================================
// GoHighLevel: Contacts Upsert (better error logging)
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
  if (!env.GHL_PRIVATE_TOKEN || !env.GHL_LOCATION_ID) {
    console.log("GHL not configured: missing GHL_PRIVATE_TOKEN or GHL_LOCATION_ID. Skipping upsert.");
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
    const text = await res.text().catch(() => "");
    console.log("GHL upsert failed:", res.status, text);
    return;
  }

  const j = await res.json().catch(() => null);
  console.log("GHL upsert success:", j);
}

// =====================================================
// Stripe helper: Get customer
// =====================================================
async function stripeGetCustomer(stripeSecretKey: string, customerId: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    console.log("Stripe get customer failed:", res.status, j);
    return null;
  }
  return j;
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
