const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.set('trust proxy', true); 
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log('MongoDB Connected');
    try {
        // 1. Migrate Call History to 60s pulse (₹1.50 per minute flat block)
        const histories = await CallHistory.find({});
        for (let h of histories) {
            let actualSecs = h.durationSeconds || Math.round((h.durationMinutes || 0) * 60);
            if (actualSecs <= 0 && h.cost) {
                // Approximate back-calculation if seconds missing
                actualSecs = Math.round((h.cost / 1.50) * 60);
            }
            const billedMinutes = actualSecs > 0 ? Math.ceil(actualSecs / 60) : 1;
            const exactCost = Number((billedMinutes * 1.50).toFixed(2));
            
            if (h.cost !== exactCost || h.durationMinutes !== billedMinutes) {
                h.durationMinutes = billedMinutes;
                h.durationSeconds = actualSecs;
                h.cost = exactCost;
                await h.save();
            }
        }

        // 2. Migrate User balances from old minutes format to ₹ Balance if needed
        const users = await User.find({});
        for (let u of users) {
            if (u.minutes !== undefined && u.minutes > 0 && u.balance === 0) {
                u.balance = Number((u.minutes * 1.50).toFixed(2));
                u.minutes = undefined; // clear old field
                await u.save();
            }
        }
        console.log('Automatic data migration & 60s pulse cost check completed successfully.');
    } catch (migErr) {
        console.error('Migration error:', migErr);
    }
}).catch(err => console.log(err));

// User Schema with Wallet Balance in Rupees (₹)
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    balance: { type: Number, default: 0 }, // Wallet balance in ₹
    verifiedPhone: { type: String, default: null },
    otpCode: { type: String, default: null },
    otpExpires: { type: Date, default: null },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },
    signupIp: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

// Call History Schema with Audit Trail
const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    callerPhone: String,      // Party A
    targetPhone: String,      // Party B
    durationMinutes: Number,  // Billed minutes (60s pulse blocks)
    durationSeconds: Number,  // Actual talk seconds
    cost: Number,             // Cost in ₹ (₹1.50 per pulse)
    clientIp: String,         
    userAgent: String,        
    date: { type: Date, default: Date.now }
});
const CallHistory = mongoose.model('CallHistory', callSchema);

async function getEdesyBalance() {
    try {
        const response = await fetch('https://voice-api.edesy.in/v1/balance', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.EDESY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();
        if (response.ok) {
            return Number(data.minutes || data.balance || 0);
        }
        return 0;
    } catch (err) {
        console.error('Error fetching Edesy balance:', err);
        return 0;
    }
}

async function getTotalAssignedPoolRupees() {
    try {
        const result = await User.aggregate([
            { $group: { _id: null, totalBalance: { $sum: "$balance" } } }
        ]);
        return result.length > 0 ? Number(result[0].totalBalance) : 0;
    } catch (err) {
        console.error('Error calculating assigned pool:', err);
        return 0;
    }
}

app.get('/api/pool-status', async (req, res) => {
    try {
        const edesyTotalMins = await getEdesyBalance();
        const edesyTotalRupees = edesyTotalMins * 1.50;
        const assignedRupees = await getTotalAssignedPoolRupees();
        const availablePoolRupees = Number((edesyTotalRupees - assignedRupees).toFixed(2));
        res.json({ edesyTotalRupees, assignedRupees, availablePoolRupees });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pool status' });
    }
});

// Google Login with Terms Acceptance & IP Logging
app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId, termsAccepted } = req.body;
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        let user = await User.findOne({ googleId });
        
        if (!user) {
            if (!termsAccepted) {
                return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to register.' });
            }

            user = new User({ 
                email, 
                name, 
                googleId, 
                balance: 0, 
                termsAccepted: true,
                termsAcceptedAt: new Date(),
                signupIp: clientIp
            });
            await user.save();
        } else {
            if (!user.termsAccepted && termsAccepted) {
                user.termsAccepted = true;
                user.termsAcceptedAt = new Date();
                user.signupIp = clientIp;
                await user.save();
            }
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
        res.json({ 
            balance: user.balance, // Returns wallet balance in ₹
            name: user.name, 
            verifiedPhone: user.verifiedPhone || '',
            termsAccepted: user.termsAccepted 
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching balance' });
    }
});

app.post('/api/send-otp', async (req, res) => {
    const { userId, phoneNumber } = req.body;
    try {
        if (!phoneNumber || phoneNumber.length !== 10) {
            return res.status(400).json({ error: 'Kripya sahi 10-digit mobile number enter karein.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        user.otpCode = otp;
        user.otpExpires = Date.now() + 5 * 60 * 1000;
        await user.save();

        console.log(`[SECURITY OTP] Number: ${phoneNumber} ke liye OTP hai: ${otp}`);
        res.json({ success: true, message: `OTP successfully bhej diya gaya hai. (Test OTP for dev: ${otp})` });
    } catch (err) {
        res.status(500).json({ error: 'OTP bhejne mein error aayi.' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const { userId, phoneNumber, otp } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.otpCode || user.otpCode !== otp || Date.now() > user.otpExpires) {
            return res.status(400).json({ error: 'Galat ya expired OTP! Kripya dobara try karein.' });
        }

        user.verifiedPhone = phoneNumber;
        user.otpCode = null;
        user.otpExpires = null;
        await user.save();

        res.json({ success: true, message: 'Number successfully verify ho gaya hai!' });
    } catch (err) {
        res.status(500).json({ error: 'OTP verification mein error aayi.' });
    }
});

app.post('/api/add-recharge', async (req, res) => {
    const { userId, baseAmount } = req.body;
    try {
        const amount = Number(baseAmount);
        if (!amount || amount < 1.50) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹1.50.' });
        }

        const edesyTotalMins = await getEdesyBalance();
        const edesyTotalRupees = edesyTotalMins * 1.50;
        const assignedRupees = await getTotalAssignedPoolRupees();
        const availablePoolRupees = Number((edesyTotalRupees - assignedRupees).toFixed(2));

        if (amount > availablePoolRupees) {
            return res.status(400).json({ 
                error: `Recharge blocked! Available pool balance: ₹${availablePoolRupees}` 
            });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.balance = Number((user.balance + amount).toFixed(2));
        await user.save();

        res.json({ 
            success: true, 
            message: `Payment confirmed! ₹${amount} added successfully.`,
            newBalance: user.balance
        });
    } catch (error) {
        res.status(500).json({ error: 'Error adding recharge amount' });
    }
});

// Call API with 60-Second Pulse Logic (₹1.50 per block)
app.post('/api/call', async (req, res) => {
    const { userId, phoneNumber, maxDuration, actualDurationSeconds } = req.body;
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.termsAccepted) {
            return res.status(400).json({ error: 'Aapko pehle Terms of Service accept karni hongi.' });
        }

        if (!user.verifiedPhone) {
            return res.status(400).json({ error: 'Pehle aapko apna mobile number OTP se verify karna hoga tabhi call lagegi!' });
        }

        const userPhone = user.verifiedPhone; 
        const ratePerPulse = 1.50; // ₹1.50 per 60 seconds pulse

        if (user.balance < ratePerPulse) {
            return res.status(400).json({ error: 'Aapka wallet balance khatam ho chuka hai! Kripya recharge karein (Minimum ₹1.50 required).' });
        }

        // Max duration calculate based on wallet balance
        let maxAllowedMinutes = Math.floor(user.balance / ratePerPulse);
        if (maxAllowedMinutes < 1) maxAllowedMinutes = 1;

        let durationLimitMinutes = maxAllowedMinutes;
        if (maxDuration !== 'unlimited' && maxDuration) {
            const requestedMins = Number(maxDuration);
            if (requestedMins < durationLimitMinutes) {
                durationLimitMinutes = requestedMins;
            }
        }

        if (user.balance < (durationLimitMinutes * ratePerPulse)) {
            return res.status(400).json({ error: `Aapke paas sufficient balance nahi hai. Required: ₹${durationLimitMinutes * ratePerPulse}` });
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
                max_duration: durationLimitMinutes
            })
        });

        const edesyData = await edesyResponse.json();
        if (!edesyResponse.ok) {
            return res.status(400).json({ error: edesyData.message || 'Edesy API failed.' });
        }

        // 60-Second Pulse Calculation (Minimum 1 block = ₹1.50)
        let actualSecs = actualDurationSeconds !== undefined && actualDurationSeconds !== null ? Number(actualDurationSeconds) : 0;
        let billedMinutes = 1; // Default minimum 1 minute pulse
        
        if (actualSecs > 0) {
            billedMinutes = Math.ceil(actualSecs / 60); // Round up to next minute block (60s pulse)
        } else {
            billedMinutes = durationLimitMinutes; // Fallback if seconds not passed
        }

        const callCost = Number((billedMinutes * ratePerPulse).toFixed(2));

        // Deduct from user wallet balance securely
        user.balance = Math.max(0, Number((user.balance - callCost).toFixed(2)));
        await user.save();

        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'Unknown';

        await CallHistory.create({ 
            userId, 
            callerPhone: userPhone,
            targetPhone: phoneNumber,
            durationMinutes: billedMinutes,
            durationSeconds: actualSecs,
            cost: callCost,
            clientIp,
            userAgent
        });

        res.json({ 
            success: true, 
            message: 'Call completed!', 
            remainingBalance: user.balance,
            durationMinutes: billedMinutes,
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