// src/index.ts
// =====================================================
// R4 Stripe Worker (DEBUG BUILD)
// Endpoints:
//   POST /api/create-checkout-session   -> returns { url, sessionId, debug, stripeMetadataEcho }
//   POST /api/stripe-webhook           -> logs webhook body (no signature verify yet)
//
// REQUIRED Worker Secrets (Cloudflare -> Settings -> Variables -> Secrets):
//   STRIPE_SECRET_KEY      = sk_test_...
//   STRIPE_WEBHOOK_SECRET  = whsec_...   (not used yet in this debug build)
//
// After we confirm metadata shows up in Stripe, I’ll give you the “production clean” version.
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
async function handleCreateCheckoutSession(
  request: Request,
  env: Env
): Promise<Response> {
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

  // DEBUG: show exactly what the Worker received
  console.log("CREATE CHECKOUT PAYLOAD:", {
    partNumber,
    serviceSummary,
    monthlyAmount: monthlyAmountNum,
    amountCents,
    customerEmail: customerEmail || "(none)",
  });

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
    // SUBSCRIPTION METADATA  ✅
    // -------------------------
    "subscription_data[metadata][partNumber]": partNumber,
    "subscription_data[metadata][serviceSummary]": serviceSummary,
    "subscription_data[metadata][monthlyAmount]": monthlyAmountNum.toFixed(2),
  };

  if (customerEmail) {
    params["customer_email"] = customerEmail;
  }

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  const stripeJson: any = await stripeRes.json().catch(() => null);

  // DEBUG: log Stripe response
  console.log("STRIPE RESPONSE STATUS:", stripeRes.status);
  console.log("STRIPE RESPONSE (first 2000 chars):", JSON.stringify(stripeJson || {}).slice(0, 2000));

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
    return json(
      { error: "Stripe did not return a checkout url", details: stripeJson },
      400,
      request
    );
  }

  // DEBUG RESPONSE: return what we sent + what Stripe echoed back
  return json(
    {
      url: stripeJson.url,
      sessionId: stripeJson.id,
      debug: {
        partNumber,
        serviceSummary,
        monthlyAmount: monthlyAmountNum.toFixed(2),
        amountCents,
      },
      stripeMetadataEcho: stripeJson.metadata ?? null,
    },
    200,
    request
  );
}

// =====================================================
// WEBHOOK (debug logging only for now)
// =====================================================
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sig = request.headers.get("Stripe-Signature") || "";
  const rawBody = await request.text();

  console.log("WEBHOOK RECEIVED:");
  console.log("Stripe-Signature:", sig);
  console.log("Body (first 2000 chars):", rawBody.slice(0, 2000));

  // NOTE: We'll add signature verification next once metadata is confirmed.
  return new Response("ok", { status: 200 });
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
