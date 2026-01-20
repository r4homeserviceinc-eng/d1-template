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

    // ============================
    // CREATE CHECKOUT SESSION
    // ============================
    if (url.pathname === "/api/create-checkout-session") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, request);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, request);
      }

      const {
        partNumber,
        monthlyAmount,
        serviceSummary,
        customerEmail,
      } = body || {};

      if (!partNumber || !monthlyAmount) {
        return json(
          { error: "Missing partNumber or monthlyAmount" },
          400,
          request
        );
      }

      const amountCents = Math.round(Number(monthlyAmount) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return json(
          { error: "monthlyAmount must be a positive number" },
          400,
          request
        );
      }

      const stripeRes = await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            mode: "subscription",
            success_url:
              "https://r4homeservice.com/stripe-success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url: "https://r4homeservice.com/stripe-cancel",

            ...(customerEmail
              ? { customer_email: String(customerEmail) }
              : {}),

            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": "usd",
            "line_items[0][price_data][recurring][interval]": "month",
            "line_items[0][price_data][unit_amount]": String(amountCents),
            "line_items[0][price_data][product_data][name]":
              "R4 Home Service Plan",
            "line_items[0][price_data][product_data][description]":
              "Custom home service membership based on your selected services.",

            "metadata[partNumber]": String(partNumber),
            "metadata[serviceSummary]": String(serviceSummary || ""),
            "metadata[monthlyAmount]": String(
              Number(monthlyAmount).toFixed(2)
            ),
          }),
        }
      );

      const stripeJson = await stripeRes.json();
      if (!stripeRes.ok) {
        return json(
          { error: "Stripe error", details: stripeJson },
          400,
          request
        );
      }

      return json({ url: stripeJson.url }, 200, request);
    }

    // ============================
    // STRIPE WEBHOOK
    // ============================
    if (url.pathname === "/api/stripe-webhook") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const sig = request.headers.get("Stripe-Signature");
      if (!sig) {
        return new Response("Missing Stripe-Signature", { status: 400 });
      }

      const rawBody = await request.text();

      // For now: accept and log.
      // (We will tighten signature verification next.)
      console.log("Stripe webhook received");
      console.log(sig);
      console.log(rawBody.slice(0, 2000));

      return new Response("ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

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
