const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const callLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    validate: { trustProxy: false }, // Yeh line express-rate-limit ke crash ko rok degi
    standardHeaders: true,
    legacyHeaders: false,
});
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.set('trust proxy', 1);
app.use(cors());
app.use(express.static('public'));

// Explicit Dashboard Route Fix
app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});
app.get('/dashboard.html', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

// ============== RATE LIMITING ==============
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Bahut saare login attempts. Kripya 15 minutes baad try karein.',
    standardHeaders: true,
    legacyHeaders: false
});

const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: 'OTP bahut jaldi bhej diya. Kripya baad mein try karein.',
    standardHeaders: true,
    legacyHeaders: false
});


const rechargeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'Bahut recharges ho rahe hain. Kripya baad mein try karein.',
    standardHeaders: true,
    legacyHeaders: false
});

// ============== PRICING CONFIGURATION ==============
const CALL_RATE_PER_MINUTE = 3.00; // ₹3 per minute (for user display)
const COMMISSION_PER_MINUTE = 1.50; // ₹1.50 commission per minute
const ACTUAL_RATE_PER_MINUTE = CALL_RATE_PER_MINUTE; // What user pays = ₹3/min

// ============== AUTHENTICATION MIDDLEWARE ==============
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-env', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// ============== VALIDATION FUNCTIONS ==============
function validatePhone(phone) {
    const phoneRegex = /^[6-9]\d{9}$/;
    return phoneRegex.test(phone);
}

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>]/g, '');
}

function encryptSensitiveData(data) {
    const algorithm = 'aes-256-cbc';
    const secretKey = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-secret-key', 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptSensitiveData(data) {
    if (!data) return null;
    
    try {
        // Agar data mein ':' nahi hai, iska matlab woh encrypted nahi balki plain text hai
        if (!data.includes(':')) {
            return data; 
        }

        const algorithm = 'aes-256-cbc';
        const secretKey = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-secret-key', 'salt', 32);
        const parts = data.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const decipher = crypto.createDecipheriv(algorithm, secretKey, iv);
        let decrypted = decipher.update(parts[1], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        // Agar decryption fail bhi ho jaye, toh error fekne ke bajaye raw data return kar dega
        console.warn('Decryption fallback to raw data:', err.message);
        return data;
    }
}

// ============== DATABASE CONNECTION ==============
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
    console.error('MONGO_URI is not defined in .env file');
    process.exit(1);
}

mongoose.connect(mongoUri).then(async () => {
    console.log('MongoDB Connected');
    try {
        // Migrate Call History to ₹3/minute with minimum ₹3 billing
        const histories = await CallHistory.find({});
        for (let h of histories) {
            let actualSecs = h.durationSeconds || Math.round((h.durationMinutes || 0) * 60);
            if (actualSecs <= 0 && h.cost) {
                actualSecs = Math.round((h.cost / ACTUAL_RATE_PER_MINUTE) * 60);
            }
            
            // BILLING LOGIC: Minimum 1 minute (60s pulse) = ₹3
            const billedMinutes = actualSecs > 0 ? Math.ceil(actualSecs / 60) : 1;
            const exactCost = Number((billedMinutes * ACTUAL_RATE_PER_MINUTE).toFixed(2));

            if (h.cost !== exactCost || h.durationMinutes !== billedMinutes) {
                h.durationMinutes = billedMinutes;
                h.durationSeconds = actualSecs;
                h.cost = exactCost;
                await h.save();
            }
        }

        // Migrate User balances
        const users = await User.find({});
        for (let u of users) {
            if (u.minutes !== undefined && u.minutes > 0 && u.balance === 0) {
                u.balance = Number((u.minutes * ACTUAL_RATE_PER_MINUTE).toFixed(2));
                u.minutes = undefined;
                await u.save();
            }
        }
        console.log('Migration completed successfully.');
    } catch (migErr) {
        console.error('Migration error:', migErr);
    }
}).catch(err => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
});

// ============== DATABASE SCHEMAS ==============
const userSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true, validate: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    name: { type: String, required: true },
    balance: { type: Number, default: 2.00, min: 0 },
    verifiedPhone: { type: String, default: null, select: false },
    otpCode: { type: String, default: null },
    otpExpires: { type: Date, default: null },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },
    signupIp: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, index: true }
});

userSchema.index({ createdAt: -1 });
userSchema.index({ email: 1, googleId: 1 });

const User = mongoose.model('User', userSchema);

const callSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    callerPhone: { type: String, required: true },
    targetPhone: { type: String, required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    durationSeconds: { type: Number, required: true, min: 0 },
    cost: { type: Number, required: true, min: 3.00 }, // Minimum ₹3 per call
    clientIp: String,
    userAgent: String,
    date: { type: Date, default: Date.now, index: true }
});

callSchema.index({ userId: 1, date: -1 });
callSchema.index({ date: -1 });
callSchema.index({ userId: 1, createdAt: -1 });

const CallHistory = mongoose.model('CallHistory', callSchema);

// ============== POOL STATUS ==============
async function getEdesyBalance() {
    try {
        const apiKey = process.env.EDESY_API_KEY;
        if (!apiKey) {
            console.warn('EDESY_API_KEY not configured');
            return 0;
        }

        const response = await fetch('https://voice-api.edesy.in/v1/balance', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });

        const data = await response.json();
        if (response.ok) {
            return Number(data.minutes || data.balance || 0);
        }
        console.warn('Edesy balance fetch failed:', data);
        return 0;
    } catch (err) {
        console.error('Error fetching Edesy balance:', err.message);
        return 0;
    }
}

async function getTotalAssignedPoolRupees() {
    try {
        const result = await User.aggregate([
            { $group: { _id: null, totalBalance: { $sum: '$balance' } } }
        ]);
        return result.length > 0 ? Number(result[0].totalBalance) : 0;
    } catch (err) {
        console.error('Error calculating assigned pool:', err.message);
        return 0;
    }
}

app.get('/api/pool-status', async (req, res) => {
    try {
        const edesyTotalMins = await getEdesyBalance();
        const edesyTotalRupees = edesyTotalMins * COMMISSION_PER_MINUTE;
        const assignedRupees = await getTotalAssignedPoolRupees();
        const availablePoolRupees = Number((edesyTotalRupees - assignedRupees).toFixed(2));
        res.json({ edesyTotalRupees, assignedRupees, availablePoolRupees });
    } catch (err) {
        console.error('Pool status error:', err.message);
        res.status(500).json({ error: 'Failed to fetch pool status' });
    }
});

// ============== AUTHENTICATION ==============
app.post('/auth/google-login', loginLimiter, async (req, res) => {
    try {
        const { email, name, googleId, termsAccepted } = req.body;

        // Validation
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        if (!name || name.length < 2) {
            return res.status(400).json({ error: 'Name must be at least 2 characters' });
        }
        if (!googleId) {
            return res.status(400).json({ error: 'Google ID is required' });
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

        let user = await User.findOne({ googleId });

        if (!user) {
            if (!termsAccepted) {
                return res.status(400).json({ error: 'Aapko Terms of Service and Privacy Policy accept karni hongi.' });
            }

            user = new User({
                email: sanitizeInput(email),
                name: sanitizeInput(name),
                googleId: sanitizeInput(googleId),
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

        // Generate JWT Token
        const token = jwt.sign(
            { userId: user._id.toString(), email: user.email },
            process.env.JWT_SECRET || 'your-secret-key-change-in-env',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                userId: user._id.toString(),
                name: user.name,
                email: user.email,
                balance: user.balance,
                termsAccepted: user.termsAccepted
            }
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ error: 'Server error during login: ' + error.message });
    }
});

// ============== ADD RECHARGE / WALLET ROUTE ==============
app.post('/api/add-recharge', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.userId;

        const addAmount = Number(amount);
        if (!addAmount || addAmount <= 0) {
            return res.status(400).json({ error: 'Valid recharge amount required' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Balance update karein
        user.balance = Number((user.balance + addAmount).toFixed(2));
        await user.save();

        res.json({
            success: true,
            message: 'Recharge successful!',
            newBalance: user.balance
        });
    } catch (error) {
        console.error('Recharge error:', error.message);
        res.status(500).json({ error: 'Server error during recharge' });
    }
});

// ============== BALANCE ==============
app.get('/api/balance/:userId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.userId && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized access' });
        }

        const user = await User.findById(req.params.userId).select('-verifiedPhone');
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            balance: user.balance,
            name: user.name,
            termsAccepted: user.termsAccepted
        });
    } catch (error) {
        console.error('Balance fetch error:', error.message);
        res.status(500).json({ error: 'Error fetching balance' });
    }
});

// ============== OTP ==============
app.post('/api/send-otp', authenticateToken, otpLimiter, async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        const userId = req.user.userId;

        if (!phoneNumber || !validatePhone(phoneNumber)) {
            return res.status(400).json({ error: 'Kripya sahi 10-digit Indian mobile number enter karein.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpCode = otp;
        user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
        await user.save();

        if (process.env.NODE_ENV !== 'production') {
            console.log(`[DEV OTP] Phone: ${phoneNumber} | OTP: ${otp}`);
            return res.json({
                success: true,
                message: 'OTP bhej diya gaya hai.',
                devOtp: otp
            });
        }

        res.json({
            success: true,
            message: 'OTP aapke number par send ho gaya hai.'
        });
    } catch (err) {
        console.error('Send OTP error:', err.message);
        res.status(500).json({ error: 'OTP bhejne mein error aayi.' });
    }
});

app.post('/api/verify-otp', authenticateToken, async (req, res) => {
    try {
        const { phoneNumber, otp } = req.body;
        const userId = req.user.userId;

        if (!phoneNumber || !validatePhone(phoneNumber)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        if (!otp || otp.length !== 6 || isNaN(otp)) {
            return res.status(400).json({ error: 'OTP must be 6 digits' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.otpCode || user.otpCode !== otp || new Date() > user.otpExpires) {
            return res.status(400).json({ error: 'Galat ya expired OTP! Kripya dobara try karein.' });
        }

        user.verifiedPhone = encryptSensitiveData(phoneNumber);
        user.otpCode = null;
        user.otpExpires = null;
        await user.save();

        res.json({ success: true, message: 'Mobile number successfully verify ho gaya!' });
    } catch (err) {
        console.error('Verify OTP error:', err.message);
        res.status(500).json({ error: 'OTP verification mein error aayi.' });
    }
});
// ============== CALL API ==============
app.post('/api/call', authenticateToken, callLimiter, async (req, res) => {
    try {
        const { phoneNumber, maxDuration, actualDurationSeconds } = req.body;
        const userId = req.user.userId;

        if (!phoneNumber || !validatePhone(phoneNumber)) {
            return res.status(400).json({ error: 'Valid phone number required (10 digits)' });
        }

        let actualSecs = 0;
        if (actualDurationSeconds !== undefined && actualDurationSeconds !== null) {
            actualSecs = Number(actualDurationSeconds);
            if (isNaN(actualSecs) || actualSecs < 0 || actualSecs > 3600) {
                return res.status(400).json({ error: 'Duration must be between 0 and 3600 seconds' });
            }
        }

        const user = await User.findById(userId).select('+verifiedPhone');
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.termsAccepted) {
            return res.status(400).json({ error: 'Pehle Terms of Service accept karni hongi.' });
        }

        // --- Safe Phone Decryption Fallback ---
        let rawPhone = user.verifiedPhone || user.phone || '9999999999';
        let decryptedPhone;
        try {
            decryptedPhone = decryptSensitiveData(rawPhone);
            if (!decryptedPhone) {
                decryptedPhone = rawPhone;
            }
        } catch (e) {
            decryptedPhone = rawPhone;
        }

        if (!decryptedPhone) {
            decryptedPhone = '9999999999';
        }

        // Minimum balance check
        if (user.balance < ACTUAL_RATE_PER_MINUTE) {
            return res.status(400).json({
                error: `Wallet balance khatam! Kripya recharge karein (Minimum ₹${ACTUAL_RATE_PER_MINUTE} required).`
            });
        }

        let maxAllowedMinutes = Math.floor(user.balance / ACTUAL_RATE_PER_MINUTE);
        if (maxAllowedMinutes < 1) maxAllowedMinutes = 1;

        let durationLimitMinutes = maxAllowedMinutes;
        if (maxDuration && maxDuration !== 'unlimited') {
            const requestedMins = Number(maxDuration);
            if (!isNaN(requestedMins) && requestedMins > 0 && requestedMins < durationLimitMinutes) {
                durationLimitMinutes = requestedMins;
            }
        }

        if (!process.env.EDESY_API_KEY) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // --- YAHAN ADD KAREIN (Country code formatting) ---
        let formattedPartyA = decryptedPhone.startsWith('91') ? decryptedPhone : '91' + decryptedPhone;
        let formattedPartyB = phoneNumber.startsWith('91') ? phoneNumber : '91' + phoneNumber;

        const edesyResponse = await fetch('https://voice-api.edesy.in/v1/masking/calls', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.EDESY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                party_a: formattedPartyA, // Updated variable yahan dena hai
                party_b: formattedPartyB, // Updated variable yahan dena hai
                max_duration: durationLimitMinutes
            })
        });

       // --- SAFE PARSING CODE ---
        const responseText = await edesyResponse.json().catch(() => null); 
        // Agar Edesy ne JSON nahi diya toh text utha lo
        let edesyData = responseText;
        
        if (!edesyResponse.ok) {
            let errorMsg = 'Call initiation failed';
            if (typeof edesyData === 'object' && edesyData !== null) {
                errorMsg = edesyData.message || edesyData.error || JSON.stringify(edesyData);
            } else {
                errorMsg = 'Edesy API error occurred';
            }
            return res.status(400).json({ error: errorMsg });
        }

        // ========== BILLING LOGIC ==========
        let billedMinutes = 1; 
        if (actualSecs > 0) {
            billedMinutes = Math.ceil(actualSecs / 60); 
        }

        const callCost = Number((billedMinutes * ACTUAL_RATE_PER_MINUTE).toFixed(2));

        // Deduct from wallet
        user.balance = Math.max(0, Number((user.balance - callCost).toFixed(2)));
        await user.save();

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'Unknown';

        await CallHistory.create({
            userId,
            callerPhone: decryptedPhone,
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
        console.error('Call error:', error.message);
        res.status(500).json({ error: 'Server error during call' });
    }
});

// ============== CALL HISTORY ==============
app.get('/api/history/:userId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.userId && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized access' });
        }

        const history = await CallHistory.find({ userId: req.params.userId })
            .sort({ date: -1 })
            .limit(100)
            .select('-userAgent');

        res.json(history);
    } catch (error) {
        console.error('History fetch error:', error.message);
        res.status(500).json({ error: 'Unable to fetch history' });
    }
});

app.delete('/api/history/:historyId', authenticateToken, async (req, res) => {
    try {
        const history = await CallHistory.findById(req.params.historyId);
        if (!history) {
            return res.status(404).json({ error: 'History record not found' });
        }

        if (req.user.userId !== history.userId.toString() && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await CallHistory.findByIdAndDelete(req.params.historyId);
        res.json({ success: true, message: 'History deleted successfully' });
    } catch (error) {
        console.error('History delete error:', error.message);
        res.status(500).json({ error: 'Failed to delete history' });
    }
});

// ============== ERROR HANDLING ==============
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Call Rate: ₹${ACTUAL_RATE_PER_MINUTE}/minute | Commission: ₹${COMMISSION_PER_MINUTE}/minute`);
});
