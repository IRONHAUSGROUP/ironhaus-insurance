require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- Helpers ----------
function makePolicyNumber(stateAbbr = 'US') {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const st = (stateAbbr || 'US').toUpperCase();
  return `IH-${y}${m}${d}-${st}-${rand}`;
}

function stateFromAddress(address = '') {
  const s = String(address).trim();

  // ", ST 12345" or " ST 12345"
  let m = s.match(/(?:,|\s)([A-Za-z]{2})\s*\d{5}(?:-\d{4})?$/i);
  if (m) return m[1].toUpperCase();

  // Any 2-letter token anywhere
  const tokens = s.split(/[^A-Za-z]/).filter(Boolean);
  for (const t of tokens) if (t.length === 2) return t.toUpperCase();

  return 'US';
}

// ---------- Google Sheets Auth ----------
const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  // works with both escaped and unescaped keys
  private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
};

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function appendToSheet(row) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:H', // Name | email | Address | Year | Make/Model | VIN | Amount | Policy Number
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// ---------- Middleware & Static ----------
app.use(cors({
  origin: [
    'https://ironhaus-insurance-1.onrender.com',
    'http://localhost:4242',
  ],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Small health + config ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    envs: {
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY: !!process.env.STRIPE_PUBLISHABLE_KEY,
      SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
      GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    },
  });
});

// Frontend will call this to get the publishable key (so it’s not hard-coded)
app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// Optional: quick Sheets test (no Stripe)
app.post('/test-sheets', async (_req, res) => {
  try {
    await appendToSheet([
      'TEST ROW', 'test@example.com', '123 Test St, NJ 07102', '2025',
      'Test Car', 'TESTVIN1234567890', '$99.00/mo', 'IH-TEST-US-ABCDE',
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ /test-sheets failed:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Stripe Checkout + Write to Sheets ----------
app.post('/create-checkout-session', async (req, res) => {
  const { fullName, makeModel, carYear, vinNumber, address, amount, email } = req.body;

  try {
    // 1) Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Auto Group Payment' },
          unit_amount: Number(amount || 0), // cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'https://ironhaus-insurance-1.onrender.com/success.html',
      cancel_url:  'https://ironhaus-insurance-1.onrender.com/cancel.html',
    });

    // 2) Policy number
    const stateAbbr = stateFromAddress(address);
    const policyNumber = makePolicyNumber(stateAbbr);

    // 3) Append to Sheet (columns A..H)
    const amountDollars = `$${(Number(amount || 0) / 100).toFixed(2)}/mo`;
    await appendToSheet([
      fullName ?? '',
      email ?? '',
      address ?? '',
      String(carYear ?? ''),
      makeModel ?? '',
      vinNumber ?? '',
      amountDollars,
      policyNumber,
    ]);

    // 4) Return session id
    res.json({ id: session.id });
  } catch (error) {
    console.error('🔥 ERROR (checkout):', error);
    res.status(500).send('Internal Server Error');
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
