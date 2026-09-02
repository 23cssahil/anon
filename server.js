const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/anonymous-call', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected')).catch(err => console.log(err));

// User Schema
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    tokens: { type: Number, default: 0 }
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

// Auth Route (Mock Google Login)
app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        let user = await User.findOne({ googleId });
        if (!user) {
            user = new User({ email, name, googleId, tokens: 10 }); // Free 10 tokens on signup
            await user.save();
        }
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get User Balance & Info
app.get('/api/balance/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        res.json({ tokens: user.tokens, name: user.name });
    } catch (error) {
        res.status(500).json({ error: 'Unable to fetch balance' });
    }
});

// Initiate Call
app.post('/api/call', async (req, res) => {
    const { userId, phoneNumber } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (user.tokens < 2) {
            return res.status(400).json({ error: 'Insufficient tokens. Please recharge.' });
        }

        user.tokens -= 2;
        await user.save();

        await CallHistory.create({
            userId,
            phoneNumber,
            duration: '1 min',
            tokensUsed: 2
        });

        res.json({ success: true, message: 'Call initiated securely via Edesy', remainingTokens: user.tokens });
    } catch (error) {
        res.status(500).json({ error: 'Call failed to connect' });
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
