const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected')).catch(err => console.log(err));

// User Schema
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    minutes: { type: Number, default: 1 } // 1 Free Minute
});
const User = mongoose.model('User', userSchema);

// Transaction Schema with Status (Pending / Approved)
const transactionSchema = new mongoose.Schema({
    txnId: { type: String, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    amount: Number,
    status: { type: String, default: 'Pending' }, // Pending, Approved, Rejected
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// Call History Schema
const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    phoneNumber: String,
    durationMinutes: Number,
    cost: Number,
    date: { type: Date, default: Date.now }
});
const CallHistory = mongoose.model('CallHistory', callSchema);

app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        let user = await User.findOne({ googleId });
        if (!user) {
            user = new User({ email, name, googleId, minutes: 1 });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/balance/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ minutes: user.minutes, name: user.name });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching balance' });
    }
});

// 1. User submits recharge request (Goes to Pending state)
app.post('/api/recharge-request', async (req, res) => {
    const { userId, amountPaid, txnId } = req.body;
    try {
        if (!amountPaid || amountPaid < 10) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹10.' });
        }
        if (!txnId || txnId.trim().length < 10) {
            return res.status(400).json({ error: 'Kripya sahi PhonePe Transaction ID (UTR) dalein.' });
        }

        const cleanTxnId = txnId.trim();
        const existingTxn = await Transaction.findOne({ txnId: cleanTxnId });
        if (existingTxn) {
            return res.status(400).json({ error: 'Yeh Transaction ID pehle hi use ki ja chuki hai!' });
        }

        // Save as Pending. Minutes will NOT be added yet!
        await Transaction.create({
            txnId: cleanTxnId,
            userId,
            amount: amountPaid,
            status: 'Pending'
        });

        res.json({ success: true, message: 'Recharge request submitted! Admin verification ke baad minutes add honge.' });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Yeh Transaction ID pehle hi use ho chuki hai!' });
        }
        res.status(500).json({ error: 'Recharge error' });
    }
});

// 2. Admin Approve Route (Aap is link ko browser se ya admin panel se call karke approve karoge)
// URL: /api/admin/approve/:txnId
app.get('/api/admin/approve/:txnId', async (req, res) => {
    try {
        const txn = await Transaction.findOne({ txnId: req.params.txnId });
        if (!txn) return res.status(404).send('Transaction not found');
        if (txn.status === 'Approved') return res.send('This transaction is already approved!');

        const user = await User.findById(txn.userId);
        if (!user) return res.status(404).send('User not found');

        // Calculate minutes (₹2.50 per minute)
        const ratePerMinute = 2.50;
        const minutesToAdd = Number((txn.amount / ratePerMinute).toFixed(2));

        user.minutes += minutesToAdd;
        await user.save();

        txn.status = 'Approved';
        await txn.save();

        res.send(`<h1>Success! ${minutesToAdd} minutes added to user account. You can close this tab.</h1>`);
    } catch (err) {
        res.status(500).send('Error approving transaction');
    }
});

// Call Route
app.post('/api/call', async (req, res) => {
    const { userId, userPhone, phoneNumber } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.minutes < 1) {
            return res.status(400).json({ error: 'Aapka balance khatam ho chuka hai! Kripya recharge karein.' });
        }

        if (!process.env.EDESY_API_KEY) {
            return res.status(500).json({ error: 'Edesy API Key is missing on server.' });
        }

        const edesyResponse = await fetch('https://voice-api.edesy.in/v1/masking/calls', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.EDESY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ party_a: userPhone, party_b: phoneNumber })
        });

        const edesyData = await edesyResponse.json();
        if (!edesyResponse.ok) {
            return res.status(400).json({ error: edesyData.message || 'Edesy API failed.' });
        }

        const usedMinutes = 1.0; 
        const callCost = Number((usedMinutes * 2.50).toFixed(2));

        user.minutes -= usedMinutes;
        await user.save();

        await CallHistory.create({ userId, phoneNumber, durationMinutes: usedMinutes, cost: callCost });

        res.json({ success: true, message: 'Call connected!', remainingMinutes: user.minutes, durationMinutes: usedMinutes, cost: callCost });
    } catch (error) {
        res.status(500).json({ error: 'Server error during call.' });
    }
});

app.get('/api/history/:userId', async (req, res) => {
    try {
        const history = await CallHistory.find({ userId: req.params.userId }).sort({ date: -1 });
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: 'Unable to fetch history' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));