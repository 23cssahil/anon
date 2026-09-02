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

// User Schema (Tokens ki jagah 'minutes' use kiya hai)
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    minutes: { type: Number, default: 5 } // Signup par 5 Free Minutes
});
const User = mongoose.model('User', userSchema);

// Call History Schema (Float duration aur cost ke sath)
const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    phoneNumber: String,
    durationMinutes: Number, // Float mein jaise 1.5 mins
    cost: Number,            // Rupee cost
    date: { type: Date, default: Date.now }
});
const CallHistory = mongoose.model('CallHistory', callSchema);

app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        let user = await User.findOne({ googleId });
        if (!user) {
            user = new User({ email, name, googleId, minutes: 5 });
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

// Manual Recharge Request (User PhonePe karke UTR/Request bhejta hai)
app.post('/api/recharge-request', async (req, res) => {
    const { userId, amountPaid, txnId } = req.body;
    try {
        if (!amountPaid || amountPaid < 10) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹10.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Maan lijiye ₹2.50 per minute ka rate rakha hai aapne (jisme Edesy + GST + Aapka 10% profit shamil hai)
        const ratePerMinute = 2.50; 
        const minutesToAdd = Number((amountPaid / ratePerMinute).toFixed(2)); // Float mein minutes calculate honge

        user.minutes += minutesToAdd;
        await user.save();

        res.json({ success: true, remainingMinutes: user.minutes, addedMinutes: minutesToAdd });
    } catch (error) {
        res.status(500).json({ error: 'Recharge error' });
    }
});

// Call Route with Float Minutes Tracking
app.post('/api/call', async (req, res) => {
    const { userId, userPhone, phoneNumber } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.minutes < 1) {
            return res.status(400).json({ error: 'Insufficient minutes. Please recharge via PhonePe.' });
        }

        if (!process.env.EDESY_API_KEY) {
            return res.status(500).json({ error: 'Edesy API Key is missing on server.' });
        }

        // Edesy API Call
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

        // Maan lijiye call ki average duration 1.5 minutes maap kar deduct ki ya standard 1 min
        const usedMinutes = 1.0; 
        const callCost = Number((usedMinutes * 2.50).toFixed(2)); // Cost calculation

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