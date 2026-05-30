const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

/* =====================================================
   ENV
===================================================== */

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL;

const PAYSTACK_BASE = "https://api.paystack.co";

/* =====================================================
   SAFETY CHECK
===================================================== */

if (!PAYSTACK_SECRET_KEY) {
  console.log("❌ Missing PAYSTACK_SECRET_KEY");
}

if (!CALLBACK_URL) {
  console.log("❌ Missing CALLBACK_URL");
}

/* =====================================================
   FIREBASE INIT (RENDER SAFE)
===================================================== */

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log("🔥 Firebase initialized (Service Account)");

  } catch (e) {
    console.log("❌ Firebase init error:", e.message);
  }
}

const db = admin.firestore();

/* =====================================================
   STK PUSH (PAYSTACK INIT TRANSACTION)
===================================================== */

app.post("/stkpush", async (req, res) => {

  try {

    const { phone, amount, sellerId } = req.body;

    if (!phone || !amount || !sellerId) {
      return res.status(400).json({
        success: false,
        message: "Missing fields"
      });
    }

    const cleanAmount = Number(amount);

    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    const reference = `JM_${Date.now()}_${sellerId}`;

    const email = `seller-${sellerId}@jamii.app`;

    const payload = {
      email,
      amount: cleanAmount * 100,
      reference,
      callback_url: CALLBACK_URL, // IMPORTANT: should be /payment-success
      metadata: {
        sellerId,
        phone
      }
    };

    console.log("📦 PAYSTACK PAYLOAD:", payload);

    const response = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ PAYSTACK RESPONSE OK");

    await db.collection("payments").add({
      sellerId,
      phone,
      amount: cleanAmount,
      reference,
      status: "pending",
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      reference,
      authorization_url: response.data.data.authorization_url
    });

  } catch (e) {
    console.log("❌ INIT ERROR:", e.response?.data || e.message);

    return res.status(500).json({
      success: false,
      error: e.response?.data || e.message
    });
  }
});

/* =====================================================
   🔥 PAYSTACK WEBHOOK (AUTO ACTIVATION)
===================================================== */

app.post("/webhook", async (req, res) => {

  try {

    console.log("🔥 WEBHOOK BODY FULL:", JSON.stringify(req.body, null, 2));

    const event = req.body;

    if (event.event === "charge.success") {

      const data = event.data;

      const reference = data.reference;
      const metadata = data.metadata;

      const sellerId = metadata?.sellerId;

      if (!sellerId) {
        console.log("⚠️ Missing sellerId");
        return res.sendStatus(200);
      }

      const expiresAt = Date.now() + (35 * 24 * 60 * 60 * 1000);

      await db.collection("sellers").doc(sellerId).update({
        paid: true,
        locked: false,
        requiresPayment: false,
        subscriptionType: "Paid Subscription",
        paidAt: Date.now(),
        expiresAt
      });

      const snap = await db.collection("payments")
        .where("reference", "==", reference)
        .limit(1)
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: "paid",
          paidAt: Date.now()
        });
      }

      console.log("🎉 SELLER ACTIVATED:", sellerId);
    }

    return res.sendStatus(200);

  } catch (e) {
    console.log("❌ WEBHOOK ERROR:", e.message);
    return res.sendStatus(200);
  }
});

/* =====================================================
   CALLBACK (OPTIONAL LOG ONLY)
===================================================== */

app.post("/callback", (req, res) => {
  console.log("📩 CALLBACK:", req.body);
  res.sendStatus(200);
});

/* =====================================================
   🎉 PAYMENT SUCCESS PAGE (FIX FOR "Cannot GET /webhook")
===================================================== */

app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Payment Success</title>
        <style>
          body {
            font-family: Arial;
            text-align: center;
            padding-top: 100px;
            background: #f5f5f5;
          }
          h1 { color: #009688; }
        </style>
      </head>
      <body>
        <h1>🎉 Payment Successful</h1>
        <p>Your Jamii subscription has been activated.</p>

        <p>Redirecting to dashboard...</p>

        <script>
          setTimeout(() => {
            window.location.href = "https://YOUR-FRONTEND-DOMAIN.com/seller.html";
          }, 3000);
        </script>
      </body>
    </html>
  `);
});

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/", (req, res) => {
  res.send("🔥 Paystack Backend Running Successfully");
});

/* =====================================================
   SERVER START
===================================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
