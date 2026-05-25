const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

/* =====================================================
   ENV CONFIG
===================================================== */

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortCode = process.env.SHORTCODE;
const passKey = process.env.PASSKEY;
const callbackURL = process.env.CALLBACK_URL;

/* =====================================================
   ENV SAFETY CHECK (IMPORTANT)
===================================================== */

if (!consumerKey || !consumerSecret || !shortCode || !passKey || !callbackURL) {
  console.log("❌ Missing environment variables!");
}

/* =====================================================
   FIREBASE INIT (RENDER SAFE)
===================================================== */

if (!admin.apps.length) {
  try {
    admin.initializeApp();
    console.log("🔥 Firebase initialized");
  } catch (e) {
    console.log("⚠️ Firebase init warning:", e.message);
  }
}

const db = admin.firestore();

/* =====================================================
   DEBUG MIDDLEWARE
===================================================== */

app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  if (req.body) console.log("BODY:", req.body);
  next();
});

/* =====================================================
   GET ACCESS TOKEN
===================================================== */

async function getToken() {
  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

    const res = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    return res.data.access_token;
  } catch (err) {
    console.log("❌ TOKEN ERROR:", err.response?.data || err.message);
    throw err;
  }
}

/* =====================================================
   STK PUSH
===================================================== */

app.post("/stkpush", async (req, res) => {
  try {
    let { phone, amount, sellerId } = req.body;

    console.log("🔥 STK REQUEST:", req.body);

    if (!phone || !amount || !sellerId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Normalize phone
    phone = phone.replace(/^0/, "254");

    const token = await getToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(shortCode + passKey + timestamp).toString(
      "base64"
    );

    const stkPayload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: parseInt(amount),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackURL,
      AccountReference: "Jamii",
      TransactionDesc: "Seller Subscription",
    };

    console.log("📦 STK PAYLOAD:", stkPayload);

    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      stkPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log("✅ STK RESPONSE:", response.data);

    // Save request (safe check)
    try {
      await db.collection("mpesaRequests").add({
        sellerId,
        phone,
        amount,
        status: "pending",
        createdAt: Date.now(),
      });
    } catch (dbErr) {
      console.log("⚠️ Firestore save skipped:", dbErr.message);
    }

    return res.json({
      success: true,
      data: response.data,
    });

  } catch (err) {
    console.log("❌ STK ERROR FULL ====================");
    console.log("STATUS:", err.response?.status || "NO STATUS");
    console.log(
      "DATA:",
      JSON.stringify(err.response?.data || err.message, null, 2)
    );
    console.log("MESSAGE:", err.message);

    return res.status(500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

/* =====================================================
   CALLBACK
===================================================== */

app.post("/callback", async (req, res) => {
  try {
    console.log("📩 CALLBACK:", JSON.stringify(req.body));

    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({ ResultCode: 0, ResultDesc: "Invalid callback" });
    }

    if (callback.ResultCode === 0) {
      const meta = callback.CallbackMetadata?.Item || [];

      const phoneItem = meta.find((x) => x.Name === "PhoneNumber");
      const phone = phoneItem ? String(phoneItem.Value) : null;

      if (phone) {
        const snap = await db
          .collection("mpesaRequests")
          .where("phone", "==", phone)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();

        if (!snap.empty) {
          const data = snap.docs[0].data();
          const sellerId = data.sellerId;

          const expiresAt = Date.now() + 35 * 24 * 60 * 60 * 1000;

          await db.collection("sellers").doc(sellerId).update({
            paid: true,
            locked: false,
            requiresPayment: false,
            subscriptionType: "Paid Subscription",
            paidAt: Date.now(),
            expiresAt,
          });

          console.log("🎉 Seller activated:", sellerId);
        }
      }
    }

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.log("❌ CALLBACK ERROR:", err.message);

    return res.json({ ResultCode: 0, ResultDesc: "Error" });
  }
});

/* =====================================================
   SERVER START
===================================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🔥 STK backend running on port", PORT);
});
