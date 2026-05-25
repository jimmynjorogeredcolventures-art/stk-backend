const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

/* =====================================================
   ENV CONFIG (DO NOT hardcode secrets)
===================================================== */

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortCode = process.env.SHORTCODE;
const passKey = process.env.PASSKEY;

/* =====================================================
   FIRESTORE (OPTIONAL - only if you still want logs)
===================================================== */

const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const db = admin.firestore();

/* =====================================================
   GET TOKEN
===================================================== */

async function getToken() {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const res = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  return res.data.access_token;
}

/* =====================================================
   STK PUSH ROUTE
===================================================== */

app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount, sellerId } = req.body;

    const token = await getToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      shortCode + passKey + timestamp
    ).toString("base64");

    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: shortCode,
        PhoneNumber: phone,
        CallBackURL: "https://YOUR-RENDER-URL.onrender.com/callback",
        AccountReference: "Jamii",
        TransactionDesc: "Seller Subscription"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    // optional logging
    await db.collection("mpesaRequests").add({
      sellerId,
      phone,
      amount,
      createdAt: Date.now()
    });

    res.json({ success: true, data: response.data });

  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   CALLBACK
===================================================== */

app.post("/callback", async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;

    if (callback.ResultCode === 0) {

      const meta = callback.CallbackMetadata.Item;

      const phone = meta.find(x => x.Name === "PhoneNumber").Value;

      const snap = await db.collection("mpesaRequests")
        .where("phone", "==", String(phone))
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!snap.empty) {

        const data = snap.docs[0].data();

        const sellerId = data.sellerId;

        const expiresAt = Date.now() + (35 * 24 * 60 * 60 * 1000);

        await db.collection("sellers").doc(sellerId).update({
          paid: true,
          locked: false,
          requiresPayment: false,
          subscriptionType: "Paid Subscription",
          paidAt: Date.now(),
          expiresAt
        });

      }
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.log(err);
    res.json({ ResultCode: 0, ResultDesc: "Error" });
  }
});

/* =====================================================
   START SERVER
===================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("STK backend running on port", PORT);
});