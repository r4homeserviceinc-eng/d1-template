// src/index.ts
// =====================================================
// R4 Stripe Worker + GoHighLevel Upsert Sync
//
// UPDATED:
//  - Accept phone + smsOptIn from selector tool
//  - Store phone + smsOptIn in Stripe metadata
//  - Parse R4 part numbers into structured fields
//  - Add House Washing tier support for GHL
//  - Push richer custom fields into GHL
//
// Endpoints:
//   POST /api/create-checkout-session
//   POST /api/create-one-time-checkout-session
//   GET  /api/get-checkout-contact
//   POST /api/create-billing-portal
//   POST /api/stripe-webhook
//
// REQUIRED Worker Secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//
// OPTIONAL:
//   GHL_PRIVATE_TOKEN
//   GHL_LOCATION_ID
// =====================================================

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  GHL_PRIVATE_TOKEN?: string;
  GHL_LOCATION_ID?: string;
}

type ParsedPlanItem = {
  raw: string;
  serviceKey: string;
  tierKey: string;
  frequency: string;
  purchaseType: "subscription" | "one_time";
};

type ParsedPartNumber = {
  items: ParsedPlanItem[];
  serviceKeysCsv: string;
  frequenciesCsv: string;
  housewashTier: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/api/create-checkout-session") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/create-one-time-checkout-session") {
      return handleCreateOneTimeCheckoutSession(request, env);
    }

    if (url.pathname === "/api/get-checkout-contact") {
      return handleGetCheckoutContact(request, env);
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
// Helpers
// =====================================================
function parseSmsOptIn(v: any): { smsOptIn: "yes" | "no"; smsOptInBool: boolean } {
  if (v === true || v === 1) return { smsOptIn: "yes", smsOptInBool: true };
  if (v === false || v === 0) return { smsOptIn: "no", smsOptInBool: false };

  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y" || s === "1") {
    return { smsOptIn: "yes", smsOptInBool: true };
  }
  return { smsOptIn: "no", smsOptInBool: false };
}

function isLikelyE164(phone: string): boolean {
  const p = String(phone || "").trim();
  if (!p.startsWith("+")) return false;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function cleanString(v: unknown): string {
  return String(v ?? "").trim();
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

function normalizeFrequency(freq: string): string {
  const f = String(freq || "").trim().toLowerCase();
  if (f === "weekly") return "weekly";
  if (f === "monthly") return "monthly";
  if (f === "quarterly") return "quarterly";
  if (f === "semiannually") return "semiannually";
  if (f === "annually") return "annually";
  if (f === "onetime" || f === "one_time") return "onetime";
  return f;
}

function humanizeHousewashTier(tierKey: string): string {
  const t = String(tierKey || "").trim().toLowerCase();
  if (t === "0to2000") return "0–2,000 sq ft";
  if (t === "2000to3500") return "2,001–3,500 sq ft";
  if (t === "3500to5000") return "3,501–5,000 sq ft";
  return tierKey;
}

/**
 * Supported examples:
 * R4HS__gutter-quarterly
 * R4HS__housewash-0to2000-quarterly
 * R4HS__housewash-2000to3500-onetime
 * R4HS__gutter-quarterly__housewash-3500to5000-annually
 */
function parsePartNumber(partNumber: string): ParsedPartNumber {
  const raw = cleanString(partNumber);
  if (!raw.startsWith("R4HS__")) {
    return {
      items: [],
      serviceKeysCsv: "",
      frequenciesCsv: "",
      housewashTier: "",
    };
  }

  const chunks = raw.replace(/^R4HS__/, "").split("__").map(s => s.trim()).filter(Boolean);
  const items: ParsedPlanItem[] = [];

  for (const chunk of chunks) {
    const parts = chunk.split("-").map(s => s.trim()).filter(Boolean);

    if (parts.length === 2) {
      const [serviceKey, frequencyRaw] = parts;
      items.push({
        raw: chunk,
        serviceKey,
        tierKey: "",
        frequency: normalizeFrequency(frequencyRaw),
        purchaseType: normalizeFrequency(frequencyRaw) === "onetime" ? "one_time" : "subscription",
      });
      continue;
    }

    if (parts.length === 3) {
      const [serviceKey, maybeTier, frequencyRaw] = parts;
      items.push({
        raw: chunk,
        serviceKey,
        tierKey: maybeTier,
        frequency: normalizeFrequency(frequencyRaw),
        purchaseType: normalizeFrequency(frequencyRaw) === "onetime" ? "one_time" : "subscription",
      });
      continue;
    }

    console.log("Unrecognized part number chunk:", chunk);
  }

  const serviceKeysCsv = uniq(items.map(i => i.serviceKey)).join(", ");
  const frequenciesCsv = uniq(
    items
      .map(i => (i.frequency === "onetime" ? "one_time" : i.frequency))
      .filter(Boolean)
  ).join(", ");

  const housewashTier = items.find(i => i.serviceKey === "housewash" && i.tierKey)?.tierKey || "";

  return {
    items,
    serviceKeysCsv,
    frequenciesCsv,
    housewashTier,
  };
}

// =====================================================
// Create Stripe Checkout Session (subscription)
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

  const partNumber = cleanString(body?.partNumber);
  const serviceSummary = cleanString(body?.serviceSummary);
  const customerEmail = cleanString(body?.customerEmail);

  const selectorPhone = cleanString(body?.phone);
  const { smsOptIn } = parseSmsOptIn(body?.smsOptIn);
  const smsOptInTs = new Date().toISOString();

  const monthlyAmountNum = Number(body?.monthlyAmount);
  const amountCents = Math.round(monthlyAmountNum * 100);

  if (!partNumber) return json({ error: "Missing partNumber" }, 400, request);
  if (!Number.isFinite(monthlyAmountNum) || amountCents <= 0) {
    return json({ error: "monthlyAmount must be a positive number" }, 400, request);
  }
  if (!selectorPhone || !isLikelyE164(selectorPhone)) {
    return json({ error: "Missing or invalid phone (E.164 required)" }, 400, request);
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

    "metadata[purchaseType]": "subscription",
    "metadata[partNumber]": partNumber,
    "metadata[serviceSummary]": serviceSummary,
    "metadata[monthlyAmount]": monthlyAmountNum.toFixed(2),
    "metadata[selectorPhone]": selectorPhone,
    "metadata[smsOptIn]": smsOptIn,
    "metadata[smsOptInTs]": smsOptInTs,

    "subscription_data[metadata][purchaseType]": "subscription",
    "subscription_data[metadata][partNumber]": partNumber,
    "subscription_data[metadata][serviceSummary]": serviceSummary,
    "subscription_data[metadata][monthlyAmount]": monthlyAmountNum.toFixed(2),
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
    console.log("Stripe create subscription session failed:", stripeRes.status, stripeJson);
    return json({ error: "Stripe error", details: stripeJson }, 400, request);
  }

  return json({ url: stripeJson.url }, 200, request);
}

// =====================================================
// Create Stripe Checkout Session (one-time)
// =====================================================
async function handleCreateOneTimeCheckoutSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, request);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const partNumber = cleanString(body?.partNumber);
  const serviceSummary = cleanString(body?.serviceSummary);

  const selectorPhone = cleanString(body?.phone);
  const { smsOptIn } = parseSmsOptIn(body?.smsOptIn);
  const smsOptInTs = new Date().toISOString();

  const oneTimeAmountNum = Number(body?.oneTimeAmount);
  const amountCents = Math.round(oneTimeAmountNum * 100);

  if (!partNumber) return json({ error: "Missing partNumber" }, 400, request);
  if (!serviceSummary) return json({ error: "Missing serviceSummary" }, 400, request);
  if (!Number.isFinite(oneTimeAmountNum) || amountCents <= 0) {
    return json({ error: "oneTimeAmount must be a positive number" }, 400, request);
  }
  if (!selectorPhone || !isLikelyE164(selectorPhone)) {
    return json({ error: "Missing or invalid phone (E.164 required)" }, 400, request);
  }

  const params: Record<string, string> = {
    mode: "payment",
    customer_creation: "always",
    success_url: "https://r4homeservice.com/stripe-success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://r4homeservice.com/stripe-cancel",

    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": "R4 Home Service — One-Time Visit",
    "line_items[0][price_data][product_data][description]": serviceSummary,

    "metadata[purchaseType]": "one_time",
    "metadata[partNumber]": partNumber,
    "metadata[serviceSummary]": serviceSummary,
    "metadata[oneTimeAmount]": oneTimeAmountNum.toFixed(2),
    "metadata[selectorPhone]": selectorPhone,
    "metadata[smsOptIn]": smsOptIn,
    "metadata[smsOptInTs]": smsOptInTs,

    "payment_intent_data[metadata][purchaseType]": "one_time",
    "payment_intent_data[metadata][partNumber]": partNumber,
    "payment_intent_data[metadata][serviceSummary]": serviceSummary,
    "payment_intent_data[metadata][oneTimeAmount]": oneTimeAmountNum.toFixed(2),
    "payment_intent_data[metadata][selectorPhone]": selectorPhone,
    "payment_intent_data[metadata][smsOptIn]": smsOptIn,
    "payment_intent_data[metadata][smsOptInTs]": smsOptInTs,
  };

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
    console.log("Stripe create one-time session failed:", stripeRes.status, stripeJson);
    return json({ error: "Stripe error", details: stripeJson }, 400, request);
  }

  return json({ url: stripeJson.url }, 200, request);
}

// =====================================================
// Billing Portal
// =====================================================
async function handleCreateBillingPortal(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, request);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const email = cleanString(body?.email).toLowerCase();
  if (!email) return json({ error: "Missing email" }, 400, request);

  const listRes = await fetch(
    "https://api.stripe.com/v1/customers?limit=1&email=" + encodeURIComponent(email),
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  const listJson: any = await listRes.json().catch(() => null);
  if (!listRes.ok) return json({ error: "Stripe error", details: listJson }, 400, request);

  const customerId = listJson?.data?.[0]?.id ? String(listJson.data[0].id) : "";
  if (!customerId) return json({ error: "No Stripe customer found for that email." }, 404, request);

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
// Stripe Webhook
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

    const mode = cleanString(session?.mode);
    const customerId = cleanString(session?.customer);
    const subscriptionId = cleanString(session?.subscription);

    const md = session?.metadata || {};
    const purchaseType = cleanString(md.purchaseType || (mode === "payment" ? "one_time" : "subscription"));

    const partNumber = cleanString(md.partNumber);
    const serviceSummary = cleanString(md.serviceSummary);
    const monthlyAmount = cleanString(md.monthlyAmount);
    const oneTimeAmount = cleanString(md.oneTimeAmount);

    const selectorPhone = cleanString(md.selectorPhone);
    const smsOptIn = cleanString(md.smsOptIn);
    const smsOptInTs = cleanString(md.smsOptInTs);

    const parsed = parsePartNumber(partNumber);

    let email = cleanString(
      session?.customer_details?.email ||
      session?.customer_email ||
      session?.customer_details?.email_address ||
      ""
    );

    let phone = cleanString(session?.customer_details?.phone);
    if (!phone && selectorPhone) phone = selectorPhone;

    let name = cleanString(session?.customer_details?.name);

    if ((!email || !name || !phone) && customerId) {
      const cust = await stripeGetCustomer(env.STRIPE_SECRET_KEY, customerId);
      if (!email) email = cleanString(cust?.email);
      if (!name) name = cleanString(cust?.name);
      if (!phone) phone = cleanString(cust?.phone);
    }

    if (customerId) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, customerId, {
        partNumber,
        serviceSummary,
        monthlyAmount: monthlyAmount || "",
        oneTimeAmount: oneTimeAmount || "",
        purchaseType,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: subscriptionId ? "active" : "n/a",
        lastCheckoutSession: cleanString(session?.id),
        selectorPhone: selectorPhone || phone,
        smsOptIn,
        smsOptInTs,
        r4ServiceKeys: parsed.serviceKeysCsv,
        r4Frequencies: parsed.frequenciesCsv,
        r4HousewashTier: parsed.housewashTier,
      });
    }

    const tags: string[] = [];
    if (purchaseType === "subscription") tags.push("R4-Subscriber");
    if (purchaseType === "one_time") tags.push("R4-OneTime");
    if (smsOptIn === "yes") tags.push("SMS-OptIn");
    if (parsed.items.some(i => i.serviceKey === "housewash")) tags.push("House-Wash");
    if (parsed.housewashTier) tags.push(`House-Wash-Tier-${parsed.housewashTier}`);

    if (!email && !phone) {
      console.log("Skipping GHL upsert: no email/phone available from Stripe session/customer.");
    } else {
      await ghlUpsertContact(env, {
        email,
        phone,
        name,
        tags: uniq(tags),
        custom: {
          r4_part_number: partNumber,
          r4_service_summary: serviceSummary,
          r4_monthly_amount: monthlyAmount,
          r4_one_time_amount: oneTimeAmount,
          r4_purchase_type: purchaseType,

          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_subscription_status: subscriptionId ? "active" : "n/a",

          r4_customer_phone: phone,
          r4_sms_opt_in: smsOptIn,
          r4_sms_opt_in_ts: smsOptInTs,

          r4_service_keys: parsed.serviceKeysCsv,
          r4_frequency_summary: parsed.frequenciesCsv,
          r4_housewash_tier_key: parsed.housewashTier,
          r4_housewash_tier_label: humanizeHousewashTier(parsed.housewashTier),
        },
      });
    }
  }

  if (type === "invoice.payment_succeeded") {
    const invoice = obj;

    const customerId = cleanString(invoice?.customer);
    const subscriptionId = cleanString(invoice?.subscription);

    const invoiceId = cleanString(invoice?.id);
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

    const customerId = cleanString(sub?.customer);
    const status = cleanString(sub?.status);
    const cancelAtPeriodEnd = Boolean(sub?.cancel_at_period_end);

    const currentPeriodEnd =
      sub?.current_period_end ? new Date(Number(sub.current_period_end) * 1000).toISOString() : "";

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
    const customerId = cleanString(sub?.customer);

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
// GoHighLevel
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
// Stripe helpers
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
// Stripe signature verification
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
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

// =====================================================
// Fetch Stripe Info for Orientation Form
// =====================================================
async function handleGetCheckoutContact(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, request);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, request);

  const url = new URL(request.url);
  const sessionId = cleanString(url.searchParams.get("session_id"));
  if (!sessionId) return json({ error: "Missing session_id" }, 400, request);

  const stripeUrl =
    "https://api.stripe.com/v1/checkout/sessions/" +
    encodeURIComponent(sessionId) +
    "?expand[]=customer&expand[]=subscription";

  const res = await fetch(stripeUrl, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  const s: any = await res.json().catch(() => null);
  if (!res.ok) {
    console.log("Stripe session lookup failed:", res.status, s);
    return json({ error: "Stripe lookup failed", details: s }, 400, request);
  }

  const md = s?.metadata || {};

  const email = cleanString(s?.customer_details?.email || s?.customer_email || s?.customer?.email);
  const phone = cleanString(s?.customer_details?.phone || s?.customer?.phone || md?.selectorPhone);
  const name = cleanString(s?.customer_details?.name || s?.customer?.name);

  return json(
    {
      email,
      phone,
      name,
      purchaseType: cleanString(md.purchaseType),
      partNumber: cleanString(md.partNumber),
      serviceSummary: cleanString(md.serviceSummary),
      monthlyAmount: cleanString(md.monthlyAmount),
      oneTimeAmount: cleanString(md.oneTimeAmount),
    },
    200,
    request
  );
}
