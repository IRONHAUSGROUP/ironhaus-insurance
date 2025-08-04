require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Google Sheets Auth
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

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

app.post('/create-checkout-session', async (req, res) => {
  const { fullName, makeModel, carYear, vinNumber, address, amount } = req.body;

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
      success_url: 'http://localhost:4242/success.html',
      cancel_url: 'http://localhost:4242/cancel.html',
    });

    // Append to Sheet
    await appendToSheet([
      fullName,
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
