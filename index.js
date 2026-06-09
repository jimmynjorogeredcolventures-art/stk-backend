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
   FIREBASE INIT
===================================================== */

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log("🔥 Firebase initialized");

  } catch (e) {
    console.log("❌ Firebase init error:", e.message);
  }
}

const db = admin.firestore();

/* =====================================================
   PAYSTACK INIT TRANSACTION
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

    /* ⚠️ FIX 1: use valid email */
    const email = "test@jamii.app";

    /* =====================================================
       PAYSTACK PAYLOAD (FIXED)
    ===================================================== */

    const payload = {
      email,
      amount: cleanAmount * 100,
      currency: "KES",               // 🔥 FIX 2 (IMPORTANT)
      reference,
      callback_url: CALLBACK_URL,
      metadata: {
        sellerId,
        phone
      }
    };

    console.log("📦 PAYSTACK PAYLOAD:", JSON.stringify(payload, null, 2));

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
    console.log(
      "❌ PAYSTACK ERROR:",
      JSON.stringify(e.response?.data, null, 2) || e.message
    );

    return res.status(500).json({
      success: false,
      error: e.response?.data || e.message
    });
  }
});

/* =====================================================
   WEBHOOK
===================================================== */

app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", JSON.stringify(req.body, null, 2));

    const event = req.body;

    if (event.event === "charge.success") {
      const { reference, metadata } = event.data;
      const sellerId = metadata?.sellerId;

      if (!sellerId) return res.sendStatus(200);

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
   CALLBACK
===================================================== */

app.post("/callback", (req, res) => {
  console.log("📩 CALLBACK:", req.body);
  res.sendStatus(200);
});

/* =====================================================
   SUCCESS PAGE
===================================================== */

app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
      <body style="text-align:center;font-family:Arial;padding-top:80px">
        <h1>🎉 Payment Successful</h1>
        <p>Your subscription is active.</p>
        <script>
          setTimeout(() => window.location.href = "/", 2000);
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
   SERVER
===================================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
