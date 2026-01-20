// src/index.ts
// =====================================================
// R4 Stripe Worker (PRODUCTION STRUCTURE)
// Endpoints:
//   POST /api/create-checkout-session
//   POST /api/stripe-webhook  (verifies Stripe signature + updates Customer metadata)
//
// REQUIRED Worker Secrets (Cloudflare -> Settings -> Variables -> Secrets):
//   STRIPE_SECRET_KEY      = sk_test_... (or sk_live_... later)
//   STRIPE_WEBHOOK_SECRET  = whsec_...
// =====================================================

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- CORS preflight ----
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
// CREATE CHECKOUT SESSION (Subscription / Monthly)
// =====================================================
async function handleCreateCheckoutSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Missing STRIPE_SECRET_KEY secret in Cloudflare Worker" }, 500, request);
  }

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

    // line item
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": "R4 Home Service Plan",
    "line_items[0][price_data][product_data][description]":
      "Custom home service membership based on your selected services.",

    // -------------------------
    // SESSION METADATA
    // -------------------------
    "metadata[partNumber]": partNumber,
    "metadata[serviceSummary]": serviceSummary,
    "metadata[monthlyAmount]": monthlyAmountNum.toFixed(2),

    // -------------------------
    // SUBSCRIPTION METADATA (shows on the subscription record)
    // -------------------------
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
  if (!stripeRes.ok) {
    return json({ error: "Stripe error", details: stripeJson }, 400, request);
  }

  return json({ url: stripeJson.url }, 200, request);
}

// =====================================================
// STRIPE WEBHOOK (signature verified)
// On checkout.session.completed -> copy metadata to Customer
// =====================================================
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });
  }
  if (!env.STRIPE_SECRET_KEY) {
    return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
  }

  const sig = request.headers.get("Stripe-Signature");
  if (!sig) return new Response("Missing Stripe-Signature", { status: 400 });

  const rawBody = await request.text();

  // 1) Verify signature
  const verified = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return new Response("Invalid signature", { status: 400 });

  // 2) Parse event
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = event?.type;

  // 3) Handle checkout complete
  if (eventType === "checkout.session.completed") {
    const session = event?.data?.object;

    const customerId = session?.customer;
    const md = session?.metadata || {};

    const partNumber = String(md.partNumber || "");
    const serviceSummary = String(md.serviceSummary || "");
    const monthlyAmount = String(md.monthlyAmount || "");

    // Only update if we have a customerId + at least one metadata field
    if (customerId && (partNumber || serviceSummary || monthlyAmount)) {
      await stripeUpdateCustomerMetadata(env.STRIPE_SECRET_KEY, String(customerId), {
        partNumber,
        serviceSummary,
        monthlyAmount,
        // helpful extra fields
        lastCheckoutSession: String(session?.id || ""),
        lastSubscription: String(session?.subscription || ""),
      });
    }
  }

  // Return 200 quickly
  return new Response("ok", { status: 200 });
}

// =====================================================
// Stripe: Update Customer metadata
// =====================================================
async function stripeUpdateCustomerMetadata(
  stripeSecretKey: string,
  customerId: string,
  metadata: Record<string, string>
) {
  // Remove empty keys so we don’t write blank values
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

  // If something fails, we still want webhook to succeed; log for later.
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    console.log("Customer metadata update failed:", res.status, j);
  }
}

// =====================================================
// Stripe signature verification (HMAC SHA256, v1 scheme)
// =====================================================
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  // Stripe-Signature looks like: "t=timestamp,v1=signature,..."
  const parts = sigHeader.split(",").map(p => p.trim());
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Parts = parts.filter(p => p.startsWith("v1="));

  if (!tPart || !v1Parts.length) return false;

  const timestamp = tPart.slice(2);
  const signedPayload = `${timestamp}.${payload}`;

  const expected = await hmacSHA256Hex(secret, signedPayload);

  // Compare against any v1 signatures (Stripe may include multiple)
  for (const v1 of v1Parts) {
    const sig = v1.slice(3);
    if (timingSafeEqualHex(sig, expected)) return true;
  }

  return false;
}

async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufferToHex(sigBuf);
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// Constant-time-ish compare for hex strings (good enough for this context)
function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa.length !== bb.length) return false;
  let res = 0;
  for (let i = 0; i < aa.length; i++) {
    res |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }
  return res === 0;
}

// ---------------- Utilities ----------------
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
