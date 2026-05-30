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
const PAYSTACK_BASE = "https://api.paystack.co";

/* =====================================================
   FIREBASE INIT
===================================================== */

if (!admin.apps.length) {
  admin.initializeApp();
  console.log("🔥 Firebase ready");
}

const db = admin.firestore();


/* =====================================================
   STK PUSH (INIT PAYMENT)
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

    const reference = `JM_${Date.now()}_${sellerId}`;

    const payload = {
      email: `${phone}@jamii.local`,
      amount: amount * 100,
      reference,
      metadata: {
        sellerId,
        phone
      },
      callback_url: process.env.CALLBACK_URL
    };

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
      amount,
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
    console.log("❌ INIT ERROR:", e.message);

    return res.status(500).json({
      success: false,
      error: e.message
    });
  }

});


/* =====================================================
   🔥 REAL PAYSTACK WEBHOOK (NO POLLING)
===================================================== */

app.post("/webhook", async (req, res) => {

  try {

    const event = req.body;

    console.log("📩 WEBHOOK RECEIVED:", event.event);

    /* =====================================================
       ONLY HANDLE SUCCESSFUL PAYMENT
    ===================================================== */

    if (event.event === "charge.success") {

      const data = event.data;

      const reference = data.reference;
      const metadata = data.metadata;

      const sellerId = metadata?.sellerId;
      const phone = metadata?.phone;

      if (!sellerId) {
        console.log("⚠️ Missing sellerId in metadata");
        return res.sendStatus(200);
      }

      console.log("💰 PAYMENT SUCCESS:", reference);

      const expiresAt =
        Date.now() + (35 * 24 * 60 * 60 * 1000);

      /* =====================================================
         ACTIVATE SELLER
      ===================================================== */

      await db.collection("sellers")
        .doc(sellerId)
        .update({
          paid: true,
          locked: false,
          requiresPayment: false,
          subscriptionType: "Paid Subscription",
          paidAt: Date.now(),
          expiresAt
        });

      /* =====================================================
         UPDATE PAYMENT RECORD
      ===================================================== */

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
    return res.sendStatus(200); // IMPORTANT: always 200
  }

});


/* =====================================================
   CALLBACK (OPTIONAL LOG ONLY)
===================================================== */

app.post("/callback", (req, res) => {
  console.log("📩 CALLBACK (IGNORED):", req.body);
  res.sendStatus(200);
});


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/", (req, res) => {
  res.send("🔥 Paystack Webhook Backend Running");
});


/* =====================================================
   START SERVER
===================================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
