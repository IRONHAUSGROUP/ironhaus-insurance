require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function makePolicyNumber(stateAbbr = 'US') {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  const rand = Math.random().toString(36).slice(2,7).toUpperCase(); // 5 chars
  const st = (stateAbbr || 'US').toUpperCase();
  return `IH-${y}${m}${d}-${st}-${rand}`;
}
function stateFromAddress(address = '') {
  const m = String(address).match(/(?:^|[\s,])([A-Za-z]{2})(?:[\s,]|\s+\d{5})/);
  return m ? m[1].toUpperCase() : 'US';
}

const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
};

const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const stateAbbr = stateFromAddress(address);
const policyNumber = makePolicyNumber(stateAbbr);

await appendToSheet([
  fullName,
  email,        // if you're recording it
  address,
  carYear,
  makeModel,
  vinNumber,
  `$${(amount / 100).toFixed(2)}/mo`,
  policyNumber  // <-- NEW COLUMN
]);

// Google Sheets append helper
async function appendToSheet(row) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
}

// Stripe Checkout Route
app.post('/create-checkout-session', async (req, res) => {
  const { fullName, makeModel, carYear, vinNumber, address, amount, email } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Auto Insurance Policy' },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: "https://ironhaus-insurance-1.onrender.com/success.html",
      cancel_url: "https://ironhaus-insurance-1.onrender.com/cancel.html",
    });

    await appendToSheet([
      fullName,
      email,
      address,
      carYear,
      makeModel,
      vinNumber,
      `$${(amount / 100).toFixed(2)}/mo`
    ]);

    res.json({ id: session.id });
  } catch (error) {
    console.error('🔥 ERROR:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(4242, () => console.log('✅ Server running on http://localhost:4242'));
