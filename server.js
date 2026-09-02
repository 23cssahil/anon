const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected')).catch(err => console.log(err));

// User Schema
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    tokens: { type: Number, default: 10 } // Free 10 tokens on signup
});
const User = mongoose.model('User', userSchema);

// Call History Schema
const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    phoneNumber: String,
    duration: String,
    tokensUsed: Number,
    date: { type: Date, default: Date.now }
});
const CallHistory = mongoose.model('CallHistory', callSchema);

// Auth Route (Mock / Google Login Handler)
app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        let user = await User.findOne({ googleId });
        if (!user) {
            user = new User({ email, name, googleId, tokens: 10 });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error during authentication' });
    }
});

// Get User Balance & Info
app.get('/api/balance/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ tokens: user.tokens, name: user.name });
    } catch (error) {
        res.status(500).json({ error: 'Unable to fetch balance' });
    }
});

// Recharge Route (Minimum ₹50 limit & Token calculation: 1 Token = ₹10)
app.post('/api/recharge', async (req, res) => {
    const { userId, amount } = req.body;

    try {
        if (!amount || amount < 50) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹50.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Calculate tokens based on amount (e.g., ₹50 = 5 tokens)
        const tokensToAdd = Math.floor(amount / 10);
        user.tokens += tokensToAdd;
        await user.save();

        res.json({ success: true, remainingTokens: user.tokens, addedTokens: tokensToAdd });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error during recharge' });
    }
});

// Initiate Real Call via Edesy Masking API
app.post('/api/call', async (req, res) => {
    const { userId, userPhone, phoneNumber } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.tokens < 2) {
            return res.status(400).json({ error: 'Insufficient tokens. Please recharge (Minimum ₹50).' });
        }

        // Real Edesy API Call Request
        const edesyResponse = await fetch('https://voice-api.edesy.in/v1/masking/calls', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.EDESY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                party_a: userPhone,    // Caller ka number
                party_b: phoneNumber   // Receiver ka target number
            })
        });

        const edesyData = await edesyResponse.json();

        if (!edesyResponse.ok) {
            return res.status(400).json({ error: edesyData.message || 'Edesy API connection failed.' });
        }

        // Deduct tokens on successful connection
        user.tokens -= 2;
        await user.save();

        // Save Call Record in History
        await CallHistory.create({
            userId,
            phoneNumber,
            duration: '1 min',
            tokensUsed: 2
        });

        res.json({ 
            success: true, 
            message: 'Call connected securely via Edesy!', 
            remainingTokens: user.tokens 
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error while connecting call.' });
    }
});

// Get Call History
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