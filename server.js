require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Stripe = require('stripe');
const { google } = require('googleapis');

const app = express();

// --- Stripe ---
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  STRIPE_SECRET_KEY is missing');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Helpers ---
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
  let m = s.match(/(?:,|\s)([A-Za-z]{2})\s*\d{5}(?:-\d{4})?$/i);
  if (m) return m[1].toUpperCase();
  const tokens = s.split(/[^A-Za-z]/).filter(Boolean);
  for (const t of tokens) if (t.length === 2) return t.toUpperCase();
  return 'US';
}

// --- Google Sheets (optional, won’t block checkout) ---
let auth = null;
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
  const credentials = {
    type: process.env.GOOGLE_TYPE,
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    auth_uri: process.env.GOOGLE_AUTH_URI,
    token_uri: process.env.GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
  };
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function appendToSheet(row) {
  if (!auth) return;
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

// --- Middleware / Static ---
app.use(cors({
  origin: [
    'https://ironhaus-insurance-1.onrender.com',
    'http://localhost:4242',
  ],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Health & Config ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    envs: {
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY: !!process.env.STRIPE_PUBLISHABLE_KEY,
      GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
      GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
    },
  });
});

app.get('/config', (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// --- Sheets test (optional) ---
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

// --- Stripe Checkout ---
// --- Stripe Checkout ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    let { fullName, makeModel, carYear, vinNumber, address, amount, email } = req.body;

    // --- Validate required fields (fail fast with clear messages) ---
    const missing = [];
    if (!fullName)  missing.push('fullName');
    if (!makeModel) missing.push('makeModel');
    if (!carYear)   missing.push('carYear');
    if (!vinNumber) missing.push('vinNumber');
    if (!address)   missing.push('address');
    if (!email)     missing.push('email');
    if (missing.length) {
      return res.status(400).json({ error: 'missing_fields', fields: missing });
    }

    // --- Normalize + validate amount (integer cents, >= 50) ---
    let intAmount = Number(amount);
    if (!Number.isFinite(intAmount)) {
      return res.status(400).json({ error: 'invalid_amount_type', got: amount });
    }
    intAmount = Math.round(intAmount);
    if (intAmount < 50) {
      return res.status(400).json({ error: 'invalid_amount_min_50', got: intAmount });
    }

    // --- Create Checkout Session ---
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,                // helps receipts + Radar
      // automatic_tax: { enabled: true },  // ONLY if you enable Tax in Dashboard
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Auto Group Payment',
            metadata: {
              fullName,
              carYear: String(carYear || ''),
              makeModel,
              vinNumber,
            },
          },
          unit_amount: intAmount, // cents
        },
        quantity: 1,
      }],
      success_url: 'https://ironhaus-insurance-1.onrender.com/success.html',
      cancel_url:  'https://ironhaus-insurance-1.onrender.com/cancel.html',
      metadata: {
        fullName,
        email,
        carYear: String(carYear || ''),
        makeModel,
        vinNumber,
        address,
      },
    });

    // --- Respond first so redirect isn't blocked ---
    res.json({ id: session.id });

    // --- Fire-and-forget: Sheets append (logs any error) ---
    const stateAbbr = stateFromAddress(address);
    const policyNumber = makePolicyNumber(stateAbbr);
    const amountDollars = `$${(intAmount / 100).toFixed(2)}/mo`;

    appendToSheet([
      fullName || '',
      email || '',
      address || '',
      String(carYear || ''),
      makeModel || '',
      vinNumber || '',
      amountDollars,
      policyNumber,
    ])
      .then(() => console.log('✓ sheet append ok'))
      .catch(err => console.error('❌ sheet append failed:', err?.message || err));

  } catch (error) {
    // Stripe errors have helpful fields; log them
    console.error('🔥 ERROR (checkout):', {
      message: error?.message,
      type:    error?.type,
      code:    error?.code,
      param:   error?.param,
      status:  error?.statusCode,
      raw:     error?.raw,
    });
    res.status(500).json({ error: 'create_session_failed', detail: error?.message || String(error) });
  }
});


// --- Start ---
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
