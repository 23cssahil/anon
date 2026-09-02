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

// User Schema (Sirf 1 Free Minute on Signup)
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    minutes: { type: Number, default: 1 } 
});
const User = mongoose.model('User', userSchema);

// Transaction Schema to Prevent Duplicate/Fake UTR usage
const transactionSchema = new mongoose.Schema({
    txnId: { type: String, unique: true },
    userId: mongoose.Schema.Types.ObjectId,
    amount: Number,
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
            user = new User({ email, name, googleId, minutes: 1 }); // 1 Free Minute
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

// Secure PhonePe Manual Recharge Request (Prevents fake/duplicate UTR)
app.post('/api/recharge-request', async (req, res) => {
    const { userId, amountPaid, txnId } = req.body;
    try {
        if (!amountPaid || amountPaid < 10) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹10.' });
        }

        if (!txnId || txnId.trim().length < 10) {
            return res.status(400).json({ error: 'Kripya sahi PhonePe Transaction ID (UTR) dalein (kam se kam 10 digits).' });
        }

        const cleanTxnId = txnId.trim();

        // Check if this Transaction ID is already used
        const existingTxn = await Transaction.findOne({ txnId: cleanTxnId });
        if (existingTxn) {
            return res.status(400).json({ error: 'Yeh Transaction ID pehle hi use ki ja chuki hai!' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Save transaction to prevent reuse
        await Transaction.create({
            txnId: cleanTxnId,
            userId,
            amount: amountPaid
        });

        // Rate calculation (₹2.50 per minute)
        const ratePerMinute = 2.50; 
        const minutesToAdd = Number((amountPaid / ratePerMinute).toFixed(2));

        user.minutes += minutesToAdd;
        await user.save();

        res.json({ success: true, remainingMinutes: user.minutes, addedMinutes: minutesToAdd });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Yeh Transaction ID pehle hi use ho chuki hai!' });
        }
        res.status(500).json({ error: 'Recharge error' });
    }
});

// Call Route (Strictly checks if minutes < 1)
app.post('/api/call', async (req, res) => {
    const { userId, userPhone, phoneNumber } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.minutes < 1) {
            return res.status(400).json({ error: 'Aapka 1 free minute khatam ho chuka hai! Kripya PhonePe se recharge karein.' });
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

        await CallHistory.create({
            userId,
            phoneNumber,
            durationMinutes: usedMinutes,
            cost: callCost
        });

        res.json({ 
            success: true, 
            message: 'Call connected via Edesy!', 
            remainingMinutes: user.minutes,
            durationMinutes: usedMinutes,
            cost: callCost
        });

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