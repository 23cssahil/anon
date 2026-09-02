const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
// Trust proxy agar aap Heroku, Render, ya Vercel par deploy kar rahe hain taaki real client IP mil sake
app.set('trust proxy', true); 
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log('MongoDB Connected');
    try {
        const histories = await CallHistory.find({});
        for (let h of histories) {
            const ratePerMinute = 3.00;
            const exactCost = Number((h.durationMinutes * ratePerMinute).toFixed(2));
            if (h.cost !== exactCost) {
                h.cost = exactCost;
                await h.save();
            }
        }
        console.log('Call history migration & cost check completed.');
    } catch (migErr) {
        console.error('Migration error:', migErr);
    }
}).catch(err => console.log(err));

// User Schema with Legal Terms Acceptance & IP Tracking
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    minutes: { type: Number, default: 0 },
    verifiedPhone: { type: String, default: null },
    otpCode: { type: String, default: null },
    otpExpires: { type: Date, default: null },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },
    signupIp: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

// Call History Schema with Audit Trail (IP, Timestamp, Verified Party A & Target Party B)
const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    callerPhone: String,      // Party A (User's Verified Phone)
    targetPhone: String,      // Party B (Destination Number)
    durationMinutes: Number,  
    cost: Number,
    clientIp: String,         // User IP Address for Legal Audit Trail
    userAgent: String,        // Device/Browser info
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

async function getTotalAssignedUserMinutes() {
    try {
        const result = await User.aggregate([
            { $group: { _id: null, totalMinutes: { $sum: "$minutes" } } }
        ]);
        return result.length > 0 ? Number(result[0].totalMinutes) : 0;
    } catch (err) {
        console.error('Error calculating assigned user minutes:', err);
        return 0;
    }
}

app.get('/api/pool-status', async (req, res) => {
    try {
        const edesyTotal = await getEdesyBalance();
        const assignedTotal = await getTotalAssignedUserMinutes();
        const availablePool = Number((edesyTotal - assignedTotal).toFixed(2));
        res.json({ edesyTotal, assignedTotal, availablePool });
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

            const edesyTotal = await getEdesyBalance();
            const assignedTotal = await getTotalAssignedUserMinutes();
            const availablePool = edesyTotal - assignedTotal;

            let freeMinutes = 0;
            if (availablePool >= 1) {
                freeMinutes = 1;
            }

            user = new User({ 
                email, 
                name, 
                googleId, 
                minutes: freeMinutes,
                termsAccepted: true,
                termsAcceptedAt: new Date(),
                signupIp: clientIp
            });
            await user.save();
        } else {
            // Update terms if not previously accepted
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
            minutes: user.minutes, 
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
        if (!baseAmount || baseAmount < 2) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹2.' });
        }

        const ratePerMinute = 3.00;
        const minutesToAdd = Number((baseAmount / ratePerMinute).toFixed(2));

        const edesyTotal = await getEdesyBalance();
        const assignedTotal = await getTotalAssignedUserMinutes();
        const availablePool = Number((edesyTotal - assignedTotal).toFixed(2));

        if (minutesToAdd > availablePool) {
            return res.status(400).json({ 
                error: `Recharge blocked! Available pool: ${availablePool} minutes.` 
            });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.minutes += minutesToAdd;
        await user.save();

        res.json({ 
            success: true, 
            message: `Payment confirmed! ${minutesToAdd} minutes added successfully.`,
            newBalance: user.minutes
        });
    } catch (error) {
        res.status(500).json({ error: 'Error adding recharge minutes' });
    }
});

// Call API with Full Audit Trail (IP tracking, verified Party A, Target Party B)
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

        const userPhone = user.verifiedPhone; // Party A locked to verified number

        if (user.minutes <= 0) {
            return res.status(400).json({ error: 'Aapka balance khatam ho chuka hai! Kripya recharge karein.' });
        }

        let durationLimit = 1.0;
        if (maxDuration === 'unlimited') {
            durationLimit = Number(user.minutes.toFixed(2));
        } else {
            durationLimit = Number(maxDuration);
            if (user.minutes < durationLimit) {
                return res.status(400).json({ error: `Aapke paas sirf ${user.minutes.toFixed(2)} minutes bache hain.` });
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

        let billedMinutes = durationLimit;
        if (actualDurationSeconds !== undefined && actualDurationSeconds !== null) {
            let calculatedMins = Number((actualDurationSeconds / 60).toFixed(4));
            if (calculatedMins < durationLimit) {
                billedMinutes = Math.max(calculatedMins, 0.0167);
            }
        }

        const ratePerMinute = 3.00;
        const callCost = Number((billedMinutes * ratePerMinute).toFixed(2));

        user.minutes = Math.max(0, Number((user.minutes - billedMinutes).toFixed(4)));
        await user.save();

        // Capture client IP and User Agent for Legal Audit Trail
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'Unknown';

        await CallHistory.create({ 
            userId, 
            callerPhone: userPhone,
            targetPhone: phoneNumber,
            durationMinutes: Number(billedMinutes.toFixed(2)), 
            cost: callCost,
            clientIp,
            userAgent
        });

        res.json({ 
            success: true, 
            message: 'Call completed!', 
            remainingMinutes: user.minutes,
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