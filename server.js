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

const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    minutes: { type: Number, default: 1 } 
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
    txnId: { type: String, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    amount: Number,
    status: { type: String, default: 'Pending' },
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

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

        await Transaction.create({ txnId: cleanTxnId, userId, amount: amountPaid, status: 'Pending' });
        res.json({ success: true, message: 'Recharge request submitted! Admin approval ke baad minutes add honge.' });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Yeh Transaction ID pehle hi use ho chuki hai!' });
        }
        res.status(500).json({ error: 'Recharge error' });
    }
});

app.get('/api/admin/approve/:txnId', async (req, res) => {
    try {
        const txn = await Transaction.findOne({ txnId: req.params.txnId });
        if (!txn) return res.status(404).send('Transaction not found');
        if (txn.status === 'Approved') return res.send('This transaction is already approved!');

        const user = await User.findById(txn.userId);
        if (!user) return res.status(404).send('User not found');

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

app.post('/api/call', async (req, res) => {
    const { userId, userPhone, phoneNumber, maxDuration } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.minutes < 1) {
            return res.status(400).json({ error: 'Aapka balance khatam ho chuka hai! Kripya recharge karein.' });
        }

        let durationLimit = 1.0;

        if (maxDuration === 'unlimited') {
            durationLimit = Number(user.minutes.toFixed(2));
        } else {
            durationLimit = Number(maxDuration);
            if (user.minutes < durationLimit) {
                return res.status(400).json({ error: `Aapke paas sirf ${user.minutes.toFixed(2)} minutes bache hain, aap ${durationLimit} minutes select nahi kar sakte.` });
            }
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
            body: JSON.stringify({ 
                party_a: userPhone, 
                party_b: phoneNumber,
                max_duration: durationLimit
            })
        });

        const edesyData = await edesyResponse.json();
        if (!edesyResponse.ok) {
            return res.status(400).json({ error: edesyData.message || 'Edesy API failed.' });
        }

        const callCost = Number((durationLimit * 2.50).toFixed(2));

        user.minutes -= durationLimit;
        await user.save();

        await CallHistory.create({ 
            userId, 
            phoneNumber, 
            durationMinutes: durationLimit, 
            cost: callCost 
        });

        res.json({ 
            success: true, 
            message: 'Call connected!', 
            remainingMinutes: user.minutes,
            durationMinutes: durationLimit,
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

// Delete History Endpoint
app.delete('/api/history/:historyId', async (req, res) => {
    try {
        await CallHistory.findByIdAndDelete(req.params.historyId);
        res.json({ success: true, message: 'History deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete history' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));