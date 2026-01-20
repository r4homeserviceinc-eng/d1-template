```ts
// src/index.ts
// ============================================
// R4 Stripe Worker (Test Mode / Production-ready structure)
// Endpoints:
//   POST /api/create-checkout-session
//   POST /api/stripe-webhook
//
// Required Cloudflare Worker Secrets:
//   STRIPE_SECRET_KEY        = sk_test_...
//   STRIPE_WEBHOOK_SECRET    = whsec_...
// ============================================

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- CORS ----
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // ---- ROUTES ----
    if (url.pathname === "/api/create-checkout-session") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// =======================================================
// CREATE CHECKOUT SESSION (Subscription / Monthly billing)
// =======================================================
async function handleCreateCheckoutSession(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, request);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const partNumber = String(body?.partNumber || "").trim();
  const monthlyAmountRaw = body?.monthlyAmount;
  const serviceSummary = String(body?.serviceSummary || "");
  const customerEmail = String(body?.customerEmail || "").trim();

  if (!partNumber) {
    return json({ error: "Missing partNumber" }, 400, request);
  }

  const monthlyAmount = Number(monthlyAmountRaw);
  const amountCents = Math.round(monthlyAmount * 100);

  if (!Number.isFinite(monthlyAmount) || amountCents <= 0) {
    return json({ error: "monthlyAmount must be a positive number" }, 400, request);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Missing STRIPE_SECRET_KEY in Worker secrets" }, 500, request);
  }

  // Build Stripe Checkout Session (server-side)
  // Using dynamic price_data so you do NOT need products/prices for each plan.
  const params = new URLSearchParams({
    mode: "subscription",
    success_url:
      "https://r4homeservice.com/stripe-success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://r4homeservice.com/stripe-cancel",

    ...(customerEmail ? { customer_email: customerEmail } : {}),

    // Line item (recurring monthly)
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
    "metadata[monthlyAmount]": monthlyAmount.toFixed(2),

    // -------------------------
    // SUBSCRIPTION METADATA ✅ (so you can see it on the subscription record)
    // -------------------------
    "subscription_data[metadata][partNumber]": partNumber,
    "subscription_data[metadata][serviceSummary]": serviceSummary,
    "subscription_data[metadata][monthlyAmount]": monthlyAmount.toFixed(2),
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const stripeJson = await stripeRes.json().catch(() => null);

  if (!stripeRes.ok) {
    return json(
      {
        error: "Stripe error",
        details: stripeJson || { message: "Unknown Stripe error" },
      },
      400,
      request
    );
  }

  if (!stripeJson?.url) {
    return json({ error: "Stripe did not return a checkout url", details: stripeJson }, 400, request);
  }

  return json({ url: stripeJson.url }, 200, request);
}

// =======================================================
// STRIPE WEBHOOK (minimal: logs + returns 200)
// NOTE: We'll harden this with signature verification next.
// =======================================================
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Raw body is required for signature verification. Keep as text.
  const rawBody = await request.text();
  const sig = request.headers.get("Stripe-Signature") || "";

  // For now: log. (Next step we will implement full signature verification.)
  console.log("Stripe webhook received");
  console.log("Stripe-Signature:", sig);
  console.log("Body (first 2000 chars):", rawBody.slice(0, 2000));

  return new Response("ok", { status: 200 });
}

// ----------------- utilities -----------------
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
```
