const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not defined');
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not defined');
    process.exit(1);
}

if (!process.env.EDESY_API_KEY) {
    console.error('EDESY_API_KEY is not defined');
    process.exit(1);
}

if (
    process.env.NODE_ENV === 'production' &&
    !process.env.EDESY_WEBHOOK_SECRET
) {
    console.error('EDESY_WEBHOOK_SECRET is required in production');
    process.exit(1);
}

app.set('trust proxy', 1);

app.use(cors());

app.use(express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}));

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'ok'
    });
});

const callLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many call requests. Please try again later.'
    }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Bahut saare login attempts. Kripya 15 minutes baad try karein.'
    }
});

const rechargeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Bahut recharges ho rahe hain. Kripya baad mein try karein.'
    }
});

const CALL_RATE_PER_MINUTE = 3.00;
const GST_RATE = 0.18;

const USER_RATE_WITH_GST = Number(
    (CALL_RATE_PER_MINUTE * (1 + GST_RATE)).toFixed(2)
);

const COMMISSION_PER_MINUTE = 1.50;

const EDESY_RATE_WITH_GST = Number(
    (COMMISSION_PER_MINUTE * (1 + GST_RATE)).toFixed(2)
);

const MAX_CALL_MINUTES = 60;

function roundMoney(value) {
    return Number(
        (Number(value) || 0).toFixed(2)
    );
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    const token =
        authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;

    if (!token) {
        return res.status(401).json({
            error: 'Access token required'
        });
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET,
        (err, user) => {
            if (err) {
                return res.status(403).json({
                    error: 'Invalid or expired token'
                });
            }

            if (!user || !user.userId) {
                return res.status(403).json({
                    error: 'Invalid token payload'
                });
            }

            req.user = user;
            next();
        }
    );
};

const adminAuth = (req, res, next) => {
    try {
        const providedPass = req.headers['x-admin-password'] || req.query.adminPassword;
        const adminPassword = process.env.ADMIN_PASSWORD || 'sahil@admin2026';

        // 1. Password-based access (from .env)
        if (providedPass && providedPass === adminPassword) {
            return next();
        }

        // 2. Token-based email fallback
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const envEmails = [
                    process.env.ADMIN_EMAIL || '',
                    process.env.ADMIN_EMAILS || ''
                ].join(',').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

                const adminEmails = [
                    '23cssahil@gmail.com',
                    'username47397@gmail.com',
                    ...envEmails
                ];
                if (decoded && decoded.email && adminEmails.includes(decoded.email.toLowerCase())) {
                    req.user = decoded;
                    return next();
                }
            } catch (e) {
                // Token invalid or expired
            }
        }

        return res.status(401).json({
            error: 'Admin authorization failed. Invalid admin password or unauthorized email.'
        });
    } catch (err) {
        return res.status(500).json({ error: 'Admin check failed' });
    }
};

const isAdmin = adminAuth;

function validatePhone(phone) {
    return typeof phone === 'string' &&
        /^[6-9]\d{9}$/.test(phone);
}

function validateEmail(email) {
    return typeof email === 'string' &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeInput(input) {
    if (typeof input !== 'string') {
        return input;
    }

    return input.trim().replace(/[<>]/g, '');
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];

    if (
        typeof forwarded === 'string' &&
        forwarded.length > 0
    ) {
        return forwarded.split(',')[0].trim();
    }

    return req.socket.remoteAddress || 'Unknown';
}

function calculateBilling(actualDurationSeconds) {
    const seconds = Math.max(
        0,
        Math.floor(
            Number(actualDurationSeconds) || 0
        )
    );

    const billableMinutes =
        seconds > 0
            ? Math.ceil(seconds / 60)
            : 0;

    const baseCost = roundMoney(
        billableMinutes *
        CALL_RATE_PER_MINUTE
    );

    const gstAmount = roundMoney(
        baseCost *
        GST_RATE
    );

    const totalCost = roundMoney(
        baseCost +
        gstAmount
    );

    const providerBaseCost = roundMoney(
        billableMinutes *
        COMMISSION_PER_MINUTE
    );

    const providerGst = roundMoney(
        providerBaseCost *
        GST_RATE
    );

    const providerTotalCost = roundMoney(
        providerBaseCost +
        providerGst
    );

    return {
        actualDurationSeconds: seconds,
        billableMinutes,
        baseCost,
        gstAmount,
        totalCost,
        providerBaseCost,
        providerGst,
        providerTotalCost
    };
}

const userSchema = new mongoose.Schema({
    googleId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        index: true,
        lowercase: true,
        trim: true,
        validate: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },

    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100
    },

    balance: {
        type: Number,
        default: 0,
        min: 0
    },

    termsAccepted: {
        type: Boolean,
        default: false
    },

    termsAcceptedAt: {
        type: Date,
        default: null
    },

    signupIp: {
        type: String,
        default: null
    },

    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

userSchema.index({
    createdAt: -1
});

userSchema.index({
    email: 1,
    googleId: 1
});

const User = mongoose.model('User', userSchema);

const callSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },

    callSid: {
        type: String,
        default: null,
        index: true
    },

    callerPhone: {
        type: String,
        required: true
    },

    targetPhone: {
        type: String,
        required: true
    },

    status: {
        type: String,
        enum: [
            'initiated',
            'ringing',
            'answered',
            'completed',
            'failed',
            'no-answer',
            'cancelled'
        ],
        default: 'initiated',
        index: true
    },

    maxDurationMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: MAX_CALL_MINUTES
    },

    durationMinutes: {
        type: Number,
        required: true,
        min: 0
    },

    durationSeconds: {
        type: Number,
        required: true,
        min: 0
    },

    baseCost: {
        type: Number,
        default: 0,
        min: 0
    },

    gstAmount: {
        type: Number,
        default: 0,
        min: 0
    },

    cost: {
        type: Number,
        required: true,
        min: 0
    },

    providerBaseCost: {
        type: Number,
        default: 0,
        min: 0
    },

    providerGst: {
        type: Number,
        default: 0,
        min: 0
    },

    providerTotalCost: {
        type: Number,
        default: 0,
        min: 0
    },

    reservedAmount: {
        type: Number,
        default: 0,
        min: 0
    },

    billingFinalized: {
        type: Boolean,
        default: false,
        index: true
    },

    billingVersion: {
        type: String,
        default: 'v2'
    },

    startedAt: {
        type: Date,
        default: Date.now
    },

    answeredAt: {
        type: Date,
        default: null
    },

    endedAt: {
        type: Date,
        default: null
    },

    clientIp: {
        type: String
    },

    userAgent: {
        type: String
    },

    edesyData: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },

    date: {
        type: Date,
        default: Date.now,
        index: true
    }
});

callSchema.index({
    userId: 1,
    date: -1
});

callSchema.index({
    callSid: 1
});

callSchema.index({
    date: -1
});

const CallHistory = mongoose.model(
    'CallHistory',
    callSchema
);

const rechargeRequestSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    utr: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    createdAt: { type: Date, default: Date.now, index: true }
});
const RechargeRequest = mongoose.model('RechargeRequest', rechargeRequestSchema);

async function getEdesyBalance() {
    try {
        const response = await fetch(
            'https://voice-api.edesy.in/v1/masking/billing',
            {
                method: 'GET',
                headers: {
                    Authorization:
                        `Bearer ${process.env.EDESY_API_KEY}`
                }
            }
        );

        if (!response.ok) {
            return 0;
        }

        const data = await response.json();

        const balance =
            data?.data?.balance ??
            data?.balance ??
            data?.data?.wallet_balance ??
            data?.wallet_balance ??
            0;

        return Number(balance) || 0;
    } catch (error) {
        console.error(
            'Edesy balance error:',
            error.message
        );

        return 0;
    }
}

async function getTotalAssignedPoolRupees() {
    try {
        const result = await User.aggregate([
            {
                $group: {
                    _id: null,
                    totalBalance: {
                        $sum: '$balance'
                    }
                }
            }
        ]);

        return result.length > 0
            ? Number(result[0].totalBalance)
            : 0;
    } catch (err) {
        console.error(
            'Error calculating assigned pool:',
            err.message
        );

        return 0;
    }
}

app.get('/api/pool-status', async (req, res) => {
    try {
        const edesyTotalMins =
            await getEdesyBalance();

        const edesyTotalRupees = roundMoney(
            edesyTotalMins *
            COMMISSION_PER_MINUTE
        );

        const assignedRupees =
            await getTotalAssignedPoolRupees();

        const availablePoolRupees = Math.max(
            0,
            roundMoney(
                edesyTotalRupees -
                assignedRupees
            )
        );

        res.json({
            edesyTotalRupees,
            assignedRupees,
            availablePoolRupees
        });
    } catch (err) {
        console.error(
            'Pool status error:',
            err.message
        );

        res.status(500).json({
            error: 'Failed to fetch pool status'
        });
    }
});

app.post(
    '/auth/google-login',
    loginLimiter,
    async (req, res) => {
        try {
            const {
                email,
                name,
                googleId,
                termsAccepted
            } = req.body;

            if (!email || !validateEmail(email)) {
                return res.status(400).json({
                    error: 'Invalid email format'
                });
            }

            if (
                !name ||
                typeof name !== 'string' ||
                name.trim().length < 2
            ) {
                return res.status(400).json({
                    error: 'Name must be at least 2 characters'
                });
            }

            if (
                !googleId ||
                typeof googleId !== 'string' ||
                googleId.trim().length < 5
            ) {
                return res.status(400).json({
                    error: 'Google ID is required'
                });
            }

            const cleanEmail =
                sanitizeInput(email).toLowerCase();

            const cleanName =
                sanitizeInput(name);

            const cleanGoogleId =
                sanitizeInput(googleId);

            const clientIp =
                getClientIp(req);

            let user = await User.findOne({
                googleId: cleanGoogleId
            });

            if (!user) {
                const existingEmailUser =
                    await User.findOne({
                        email: cleanEmail
                    });

                if (existingEmailUser) {
                    return res.status(409).json({
                        error:
                            'An account with this email already exists.'
                    });
                }

                if (!termsAccepted) {
                    return res.status(400).json({
                        error:
                            'Aapko Terms of Service and Privacy Policy accept karni hongi.'
                    });
                }

                user = new User({
                    email: cleanEmail,
                    name: cleanName,
                    googleId: cleanGoogleId,
                    balance: 0,
                    termsAccepted: true,
                    termsAcceptedAt: new Date(),
                    signupIp: clientIp
                });

                await user.save();
            } else {
                let changed = false;

                if (user.email !== cleanEmail) {
                    user.email = cleanEmail;
                    changed = true;
                }

                if (user.name !== cleanName) {
                    user.name = cleanName;
                    changed = true;
                }

                if (!user.termsAccepted && termsAccepted) {
                    user.termsAccepted = true;
                    user.termsAcceptedAt = new Date();
                    changed = true;
                }

                if (changed) {
                    await user.save();
                }
            }

            const token = jwt.sign(
                {
                    userId: user._id.toString(),
                    email: user.email
                },
                process.env.JWT_SECRET,
                {
                    expiresIn: '7d'
                }
            );

            res.json({
                success: true,
                token,
                user: {
                    userId:
                        user._id.toString(),
                    name: user.name,
                    email: user.email,
                    balance:
                        roundMoney(user.balance),
                    termsAccepted:
                        user.termsAccepted
                }
            });
        } catch (error) {
            console.error(
                'Login error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Server error during login'
            });
        }
    }
);

app.post(
    '/api/add-recharge',
    authenticateToken,
    rechargeLimiter,
    async (req, res) => {
        try {
            const baseAmount = Number(req.body.amount);
            const utr = req.body.utr;

            if (!Number.isFinite(baseAmount) || baseAmount < 3 || baseAmount > 100000) {
                return res.status(400).json({ error: 'Valid recharge amount required (min ₹3)' });
            }

            if (!utr || typeof utr !== 'string' || utr.trim().length < 12) {
                return res.status(400).json({ error: 'Valid 12-digit UTR/Reference number required' });
            }

            const cleanUtr = sanitizeInput(utr);

            const existing = await RechargeRequest.findOne({ utr: cleanUtr });
            if (existing) {
                return res.status(400).json({ error: 'This UTR has already been submitted.' });
            }

            const request = new RechargeRequest({
                userId: req.user.userId,
                amount: baseAmount,
                utr: cleanUtr,
                status: 'pending'
            });

            await request.save();

            res.json({
                success: true,
                message: 'Recharge request submitted successfully. It will be verified shortly.'
            });
        } catch (error) {
            console.error('Recharge request error:', error.message);
            res.status(500).json({ error: 'Server error during recharge request' });
        }
    }
);

app.get('/api/user/recharges', authenticateToken, async (req, res) => {
    try {
        const requests = await RechargeRequest.find({ userId: req.user.userId })
            .sort({ createdAt: -1 })
            .limit(20);
        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch recharge history' });
    }
});

app.post('/api/admin/verify-password', (req, res) => {
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD || 'sahil@admin2026';
    if (password && password === adminPassword) {
        return res.json({ success: true, message: 'Password verified successfully' });
    }
    return res.status(401).json({ success: false, error: 'Incorrect Admin Password' });
});

app.get('/api/admin/recharges', adminAuth, async (req, res) => {
    try {
        const requests = await RechargeRequest.find({ status: 'pending' })
            .populate('userId', 'name email')
            .sort({ createdAt: -1 });
        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pending requests' });
    }
});

app.post('/api/admin/recharges/:id/approve', adminAuth, async (req, res) => {
    try {
        const reqDoc = await RechargeRequest.findById(req.params.id);
        if (!reqDoc || reqDoc.status !== 'pending') {
            return res.status(400).json({ error: 'Invalid or already processed request' });
        }

        reqDoc.status = 'approved';
        await reqDoc.save();

        const user = await User.findById(reqDoc.userId);
        if (user) {
            user.balance = roundMoney(user.balance + reqDoc.amount);
            await user.save();
        }

        res.json({ success: true, message: 'Recharge approved and balance added.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to approve recharge' });
    }
});

app.post('/api/admin/recharges/:id/reject', adminAuth, async (req, res) => {
    try {
        const reqDoc = await RechargeRequest.findById(req.params.id);
        if (!reqDoc || reqDoc.status !== 'pending') {
            return res.status(400).json({ error: 'Invalid or already processed request' });
        }

        reqDoc.status = 'rejected';
        await reqDoc.save();

        res.json({ success: true, message: 'Recharge rejected.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reject recharge' });
    }
}
);

app.get(
    '/api/balance/:userId',
    authenticateToken,
    async (req, res) => {
        try {
            if (
                req.user.userId !==
                    req.params.userId &&
                !req.user.isAdmin
            ) {
                return res.status(403).json({
                    error:
                        'Unauthorized access'
                });
            }

            if (
                !mongoose.isValidObjectId(
                    req.params.userId
                )
            ) {
                return res.status(400).json({
                    error:
                        'Invalid user ID'
                });
            }

            const user =
                await User.findById(
                    req.params.userId
                );

            if (!user) {
                return res.status(404).json({
                    error:
                        'User not found'
                });
            }

            res.json({
                balance:
                    roundMoney(user.balance),
                name:
                    user.name,
                termsAccepted:
                    user.termsAccepted
            });
        } catch (error) {
            console.error(
                'Balance fetch error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Error fetching balance'
            });
        }
    }
);

app.get(
    '/api/user/profile',
    authenticateToken,
    async (req, res) => {
        try {
            const user = await User.findById(req.user.userId);

            if (!user) {
                return res.status(404).json({
                    error: 'User not found'
                });
            }

            res.json({
                success: true,
                user: {
                    userId: user._id.toString(),
                    name: user.name,
                    email: user.email,
                    balance: roundMoney(user.balance),
                    termsAccepted: user.termsAccepted,
                    memberSince: user.createdAt
                }
            });
        } catch (error) {
            console.error('Profile fetch error:', error.message);
            res.status(500).json({
                error: 'Error fetching profile'
            });
        }
    }
);

app.post(
    '/api/call',
    authenticateToken,
    callLimiter,
    async (req, res) => {
        let reserveAmount = 0;
        let reservationTaken = false;

        try {
            const phoneNumber =
                String(
                    req.body.phoneNumber || ''
                ).trim();

            const userPhone =
                String(
                    req.body.userPhone || ''
                ).trim();

            const maxDuration =
                req.body.maxDuration;

            const userId =
                req.user.userId;

            if (!validatePhone(userPhone)) {
                return res.status(400).json({
                    error:
                        'Valid caller phone number required (10 digits)'
                });
            }

            if (!validatePhone(phoneNumber)) {
                return res.status(400).json({
                    error:
                        'Valid target phone number required (10 digits)'
                });
            }

            if (userPhone === phoneNumber) {
                return res.status(400).json({
                    error:
                        'Caller and target numbers cannot be the same.'
                });
            }

            const user =
                await User.findById(userId);

            if (!user) {
                return res.status(404).json({
                    error:
                        'User not found'
                });
            }

            if (!user.termsAccepted) {
                return res.status(400).json({
                    error:
                        'Pehle Terms of Service accept karni hongi.'
                });
            }

            if (
                !Number.isFinite(user.balance) ||
                user.balance <
                    USER_RATE_WITH_GST
            ) {
                return res.status(400).json({
                    error:
                        `Wallet balance khatam! Minimum ₹${USER_RATE_WITH_GST.toFixed(2)} required.`
                });
            }

            let maxAllowedMinutes =
                Math.floor(
                    user.balance /
                    USER_RATE_WITH_GST
                );

            maxAllowedMinutes =
                Math.min(
                    maxAllowedMinutes,
                    MAX_CALL_MINUTES
                );

            if (maxAllowedMinutes < 1) {
                return res.status(400).json({
                    error:
                        `Minimum ₹${USER_RATE_WITH_GST.toFixed(2)} balance required.`
                });
            }

            let durationLimitMinutes =
                maxAllowedMinutes;

            if (
                maxDuration !== undefined &&
                maxDuration !== null &&
                maxDuration !== '' &&
                maxDuration !== 'unlimited'
            ) {
                const requestedMins =
                    Number(maxDuration);

                if (
                    !Number.isInteger(requestedMins) ||
                    requestedMins < 1 ||
                    requestedMins > MAX_CALL_MINUTES
                ) {
                    return res.status(400).json({
                        error:
                            `Maximum duration must be between 1 and ${MAX_CALL_MINUTES} minutes.`
                    });
                }

                durationLimitMinutes =
                    Math.min(
                        requestedMins,
                        maxAllowedMinutes
                    );
            }

            reserveAmount = roundMoney(
                durationLimitMinutes *
                USER_RATE_WITH_GST
            );

            const clientIp =
                getClientIp(req);

            const userAgent =
                req.headers['user-agent'] ||
                'Unknown';

            const reservedUser =
                await User.findOneAndUpdate(
                    {
                        _id: userId,
                        balance: {
                            $gte: reserveAmount
                        }
                    },
                    {
                        $inc: {
                            balance:
                                -reserveAmount
                        }
                    },
                    {
                        new: true
                    }
                );

            if (!reservedUser) {
                return res.status(400).json({
                    error:
                        'Insufficient wallet balance.'
                });
            }

            reservationTaken = true;

            let edesyData = null;

            try {
                const edesyResponse =
                    await fetch(
                        'https://voice-api.edesy.in/v1/masking/calls',
                        {
                            method: 'POST',
                            headers: {
                                Authorization:
                                    `Bearer ${process.env.EDESY_API_KEY}`,
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    party_a:
                                        userPhone,
                                    party_b:
                                        phoneNumber,
                                    // CRITICAL FIX: Pass max_duration so Edesy auto-disconnects
                                    // the call after durationLimitMinutes. Without this, calls
                                    // ran forever regardless of user's selected limit.
                                    max_duration:
                                        durationLimitMinutes
                                })
                        }
                    );

                try {
                    edesyData =
                        await edesyResponse.json();
                } catch {
                    edesyData = null;
                }

                if (!edesyResponse.ok) {
                    await User.findByIdAndUpdate(
                        userId,
                        {
                            $inc: {
                                balance:
                                    reserveAmount
                            }
                        }
                    );

                    reservationTaken = false;

                    const errorMsg =
                        edesyData?.message ||
                        edesyData?.error ||
                        edesyData?.data?.message ||
                        'Edesy API error occurred';

                    return res.status(400).json({
                        error:
                            errorMsg,
                        edesy:
                            edesyData
                    });
                }
            } catch (providerError) {
                await User.findByIdAndUpdate(
                    userId,
                    {
                        $inc: {
                            balance:
                                reserveAmount
                        }
                    }
                );

                reservationTaken = false;

                throw providerError;
            }

            const callSid =
                edesyData?.call_sid ||
                edesyData?.data?.call_sid ||
                edesyData?.callSid ||
                edesyData?.data?.callSid ||
                null;

            if (!callSid) {
                await User.findByIdAndUpdate(
                    userId,
                    {
                        $inc: {
                            balance:
                                reserveAmount
                        }
                    }
                );

                reservationTaken = false;

                return res.status(502).json({
                    error:
                        'Edesy did not return a call_sid. Amount refunded.',
                    edesy:
                        edesyData
                });
            }

            try {
                await CallHistory.create({
                    userId,
                    callSid,
                    callerPhone:
                        userPhone,
                    targetPhone:
                        phoneNumber,
                    status:
                        'initiated',
                    maxDurationMinutes:
                        durationLimitMinutes,
                    durationMinutes:
                        0,
                    durationSeconds:
                        0,
                    baseCost:
                        0,
                    gstAmount:
                        0,
                    cost:
                        0,
                    providerBaseCost:
                        0,
                    providerGst:
                        0,
                    providerTotalCost:
                        0,
                    reservedAmount:
                        reserveAmount,
                    billingFinalized:
                        false,
                    billingVersion:
                        'v2',
                    startedAt:
                        new Date(),
                    clientIp,
                    userAgent,
                    edesyData
                });
            } catch (historyError) {
                await User.findByIdAndUpdate(
                    userId,
                    {
                        $inc: {
                            balance:
                                reserveAmount
                        }
                    }
                );

                reservationTaken = false;

                throw historyError;
            }

            res.json({
                success: true,
                message:
                    'Call initiated successfully!',
                callSid,
                remainingBalance:
                    roundMoney(
                        reservedUser.balance
                    ),
                reservedAmount:
                    reserveAmount,
                maxDurationMinutes:
                    durationLimitMinutes,
                ratePerMinute:
                    CALL_RATE_PER_MINUTE,
                gstRate:
                    GST_RATE,
                userRateWithGst:
                    USER_RATE_WITH_GST,
                edesy:
                    edesyData
            });
        } catch (error) {
            console.error(
                'Call error:',
                error.message
            );

            if (
                reservationTaken &&
                reserveAmount > 0
            ) {
                try {
                    await User.findByIdAndUpdate(
                        req.user.userId,
                        {
                            $inc: {
                                balance:
                                    reserveAmount
                            }
                        }
                    );
                } catch (refundError) {
                    console.error(
                        'Emergency refund error:',
                        refundError.message
                    );
                }
            }

            res.status(500).json({
                error:
                    'Server error during call'
            });
        }
    }
);

function extractCallSid(payload) {
    return (
        payload?.call_sid ||
        payload?.callSid ||
        payload?.data?.call_sid ||
        payload?.data?.callSid ||
        payload?.call?.call_sid ||
        payload?.call?.callSid ||
        payload?.data?.call?.call_sid ||
        payload?.data?.call?.callSid ||
        null
    );
}

function extractDurationSeconds(payload) {
    const values = [
        payload?.duration_seconds,
        payload?.durationSeconds,
        payload?.duration_sec,
        payload?.durationSec,
        payload?.call_duration,
        payload?.callDuration,
        payload?.duration,
        payload?.data?.duration_seconds,
        payload?.data?.durationSeconds,
        payload?.data?.duration_sec,
        payload?.data?.durationSec,
        payload?.data?.call_duration,
        payload?.data?.callDuration,
        payload?.data?.duration,
        payload?.data?.call?.duration_seconds,
        payload?.data?.call?.durationSeconds,
        payload?.data?.call?.duration,
        payload?.call?.duration_seconds,
        payload?.call?.durationSeconds,
        payload?.call?.duration
    ];

    for (const value of values) {
        if (
            typeof value === 'string' &&
            value.includes(':')
        ) {
            const parts =
                value.split(':').map(Number);

            if (
                parts.length === 3 &&
                parts.every(Number.isFinite)
            ) {
                return Math.floor(
                    parts[0] * 3600 +
                    parts[1] * 60 +
                    parts[2]
                );
            }

            if (
                parts.length === 2 &&
                parts.every(Number.isFinite)
            ) {
                return Math.floor(
                    parts[0] * 60 +
                    parts[1]
                );
            }
        }

        const seconds =
            Number(value);

        if (
            Number.isFinite(seconds) &&
            seconds >= 0
        ) {
            return Math.floor(seconds);
        }
    }

    return 0;
}

function extractEventName(payload) {
    return String(
        payload?.event ||
        payload?.event_type ||
        payload?.eventType ||
        payload?.type ||
        payload?.status ||
        payload?.call_status ||
        payload?.callStatus ||
        payload?.data?.event ||
        payload?.data?.event_type ||
        payload?.data?.eventType ||
        payload?.data?.status ||
        ''
    ).toLowerCase();
}

function extractStatus(payload) {
    const eventName =
        extractEventName(payload);

    if (
        eventName.includes('no-answer') ||
        eventName.includes('no_answer') ||
        eventName.includes('noanswer') ||
        eventName.includes('missed')
    ) {
        return 'no-answer';
    }

    if (
        eventName.includes('failed') ||
        eventName.includes('failure')
    ) {
        return 'failed';
    }

    if (eventName.includes('cancel')) {
        return 'cancelled';
    }

    if (
        eventName.includes('answered') ||
        eventName.includes('bridged') ||
        eventName.includes('connected')
    ) {
        return 'answered';
    }

    if (eventName.includes('ring')) {
        return 'ringing';
    }

    if (
        eventName.includes('started') ||
        eventName.includes('initiated')
    ) {
        return 'initiated';
    }

    if (
        eventName.includes('ended') ||
        eventName.includes('completed') ||
        eventName.includes('expired')
    ) {
        return 'completed';
    }

    return null;
}

function verifyEdesyWebhook(req) {
    const secret =
        process.env.EDESY_WEBHOOK_SECRET;

    // In non-production (dev/staging), allow webhooks without secret for testing
    if (!secret) {
        if (process.env.NODE_ENV !== 'production') {
            return true;
        }
        return false;
    }

    const received =
        req.headers['x-edesy-signature'];

    if (
        typeof received !== 'string' ||
        !received
    ) {
        return false;
    }

    const rawBody =
        Buffer.isBuffer(req.rawBody)
            ? req.rawBody
            : null;

    if (!rawBody) {
        return false;
    }

    const expected =
        crypto
            .createHmac(
                'sha256',
                secret
            )
            .update(rawBody)
            .digest('hex');

    const normalizedReceived =
        received.startsWith('sha256=')
            ? received.slice(7)
            : received;

    if (
        normalizedReceived.length !==
        expected.length
    ) {
        return false;
    }

    try {
        return crypto.timingSafeEqual(
            Buffer.from(
                normalizedReceived,
                'utf8'
            ),
            Buffer.from(
                expected,
                'utf8'
            )
        );
    } catch {
        return false;
    }
}

app.post(
    '/api/webhooks/edesy',
    async (req, res) => {
        try {
            if (!verifyEdesyWebhook(req)) {
                return res.status(401).json({
                    error:
                        'Invalid webhook signature'
                });
            }

            const payload =
                req.body || {};

            const callSid =
                extractCallSid(payload);

            const eventName =
                extractEventName(payload);

            if (!callSid) {
                console.log(
                    'Edesy webhook test/event without call_sid:',
                    eventName || 'unknown'
                );

                return res.status(200).json({
                    success: true,
                    ignored: true,
                    test: true,
                    reason:
                        'No call_sid in event'
                });
            }

            const status =
                extractStatus(payload);

            const durationSeconds =
                extractDurationSeconds(payload);

            const history =
                await CallHistory.findOne({
                    callSid
                });

            if (!history) {
                console.log(
                    'Webhook for unknown call:',
                    callSid
                );

                return res.status(200).json({
                    success: true,
                    ignored: true,
                    reason:
                        'Call history not found',
                    callSid
                });
            }

            const terminalStatuses = [
                'completed',
                'failed',
                'no-answer',
                'cancelled'
            ];

            if (
                status &&
                terminalStatuses.includes(
                    status
                )
            ) {
                const claimedHistory =
                    await CallHistory.findOneAndUpdate(
                        {
                            _id:
                                history._id,
                            billingFinalized:
                                false
                        },
                        {
                            $set: {
                                billingFinalized:
                                    true
                            }
                        },
                        {
                            new: true
                        }
                    );

                if (!claimedHistory) {
                    return res.status(200).json({
                        success: true,
                        alreadyFinalized:
                            true
                    });
                }

                const billing =
                    calculateBilling(
                        durationSeconds
                    );

                const reservedAmount =
                    roundMoney(
                        claimedHistory
                            .reservedAmount || 0
                    );

                const finalCharge =
                    Math.min(
                        billing.totalCost,
                        reservedAmount
                    );

                const refund =
                    roundMoney(
                        reservedAmount -
                        finalCharge
                    );

                if (refund > 0) {
                    await User.findByIdAndUpdate(
                        claimedHistory.userId,
                        {
                            $inc: {
                                balance:
                                    refund
                            }
                        }
                    );
                }

                await CallHistory.findByIdAndUpdate(
                    claimedHistory._id,
                    {
                        $set: {
                            status,
                            durationSeconds:
                                billing
                                    .actualDurationSeconds,
                            durationMinutes:
                                billing
                                    .billableMinutes,
                            baseCost:
                                billing.baseCost,
                            gstAmount:
                                billing.gstAmount,
                            cost:
                                finalCharge,
                            providerBaseCost:
                                billing
                                    .providerBaseCost,
                            providerGst:
                                billing
                                    .providerGst,
                            providerTotalCost:
                                billing
                                    .providerTotalCost,
                            endedAt:
                                new Date(),
                            edesyData:
                                payload
                        }
                    }
                );

                return res.status(200).json({
                    success: true,
                    callSid,
                    status,
                    durationSeconds:
                        billing
                            .actualDurationSeconds,
                    billableMinutes:
                        billing
                            .billableMinutes,
                    charged:
                        finalCharge,
                    refunded:
                        refund
                });
            }

            const update = {
                edesyData:
                    payload
            };

            if (status) {
                update.status =
                    status;
            }

            if (status === 'answered') {
                update.answeredAt =
                    history.answeredAt ||
                    new Date();
            }

            if (durationSeconds > 0) {
                update.durationSeconds =
                    durationSeconds;

                update.durationMinutes =
                    Math.ceil(
                        durationSeconds /
                        60
                    );
            }

            await CallHistory.findByIdAndUpdate(
                history._id,
                {
                    $set:
                        update
                }
            );

            return res.status(200).json({
                success: true,
                callSid,
                status:
                    status || null
            });
        } catch (error) {
            console.error(
                'Edesy webhook error:',
                error.message
            );

            return res.status(500).json({
                error:
                    'Webhook processing failed'
            });
        }
    }
);

app.get(
    '/api/call-status/:callSid',
    authenticateToken,
    async (req, res) => {
        try {
            const callSid =
                String(
                    req.params.callSid || ''
                ).trim();

            if (!callSid) {
                return res.status(400).json({
                    error:
                        'callSid required'
                });
            }

            const history =
                await CallHistory.findOne({
                    callSid
                });

            if (!history) {
                return res.status(404).json({
                    error:
                        'Call history not found'
                });
            }

            if (
                req.user.userId !==
                    history.userId.toString() &&
                !req.user.isAdmin
            ) {
                return res.status(403).json({
                    error:
                        'Unauthorized'
                });
            }

            res.json({
                success: true,
                callSid:
                    history.callSid,
                status:
                    history.status,
                durationSeconds:
                    history.durationSeconds,
                durationMinutes:
                    history.durationMinutes,
                cost:
                    history.cost,
                billingFinalized:
                    history.billingFinalized,
                maxDurationMinutes:
                    history.maxDurationMinutes,
                reservedAmount:
                    history.reservedAmount,
                endedAt:
                    history.endedAt
            });
        } catch (error) {
            console.error(
                'Call status error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch call status'
            });
        }
    }
);

app.get(
    '/api/history/:userId',
    authenticateToken,
    async (req, res) => {
        try {
            if (
                req.user.userId !==
                    req.params.userId &&
                !req.user.isAdmin
            ) {
                return res.status(403).json({
                    error:
                        'Unauthorized access'
                });
            }

            if (
                !mongoose.isValidObjectId(
                    req.params.userId
                )
            ) {
                return res.status(400).json({
                    error:
                        'Invalid user ID'
                });
            }

            const history =
                await CallHistory.find({
                    userId:
                        req.params.userId
                })
                    .sort({
                        date: -1
                    })
                    .limit(100)
                    .select(
                        '-userAgent'
                    );

            res.json(history);
        } catch (error) {
            console.error(
                'History fetch error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch history'
            });
        }
    }
);

app.delete(
    '/api/history/:historyId',
    authenticateToken,
    async (req, res) => {
        try {
            if (
                !mongoose.isValidObjectId(
                    req.params.historyId
                )
            ) {
                return res.status(400).json({
                    error:
                        'Invalid history ID'
                });
            }

            const history =
                await CallHistory.findById(
                    req.params.historyId
                );

            if (!history) {
                return res.status(404).json({
                    error:
                        'History record not found'
                });
            }

            if (
                req.user.userId !==
                    history.userId.toString() &&
                !req.user.isAdmin
            ) {
                return res.status(403).json({
                    error:
                        'Unauthorized'
                });
            }

            await CallHistory.findByIdAndDelete(
                req.params.historyId
            );

            res.json({
                success: true,
                message:
                    'History deleted successfully'
            });
        } catch (error) {
            console.error(
                'History delete error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Failed to delete history'
            });
        }
    }
);

app.use(
    (err, req, res, next) => {
        console.error(
            'Unhandled error:',
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            error:
                'Internal server error'
        });
    }
);

const PORT = Number(
    process.env.PORT || 3000
);

if (
    !Number.isInteger(PORT) ||
    PORT < 1 ||
    PORT > 65535
) {
    console.error(
        'Invalid PORT'
    );

    process.exit(1);
}

async function migrateDatabase() {
    try {
        console.log(
            'Running SAFE database migration...'
        );

        const collection =
            CallHistory.collection;

        const histories =
            await collection
                .find({})
                .toArray();

        let historyUpdates = 0;

        for (const h of histories) {
            const set = {};

            if (
                h.durationSeconds === undefined ||
                h.durationSeconds === null
            ) {
                const legacyMinutes =
                    Number(
                        h.durationMinutes ??
                        h.minutes ??
                        0
                    );

                set.durationSeconds =
                    Number.isFinite(
                        legacyMinutes
                    ) &&
                    legacyMinutes > 0
                        ? Math.floor(
                            legacyMinutes * 60
                        )
                        : 0;
            }

            if (
                h.durationMinutes === undefined ||
                h.durationMinutes === null
            ) {
                const seconds =
                    Number(
                        h.durationSeconds ||
                        0
                    );

                set.durationMinutes =
                    Number.isFinite(seconds) &&
                    seconds > 0
                        ? Math.ceil(
                            seconds / 60
                        )
                        : 0;
            }

            if (
                h.cost === undefined ||
                h.cost === null
            ) {
                set.cost = 0;
            }

            if (
                h.baseCost === undefined ||
                h.baseCost === null
            ) {
                set.baseCost =
                    Number(h.cost || 0);
            }

            if (
                h.gstAmount === undefined ||
                h.gstAmount === null
            ) {
                set.gstAmount = 0;
            }

            if (
                h.providerBaseCost === undefined ||
                h.providerBaseCost === null
            ) {
                set.providerBaseCost = 0;
            }

            if (
                h.providerGst === undefined ||
                h.providerGst === null
            ) {
                set.providerGst = 0;
            }

            if (
                h.providerTotalCost === undefined ||
                h.providerTotalCost === null
            ) {
                set.providerTotalCost = 0;
            }

            if (
                h.reservedAmount === undefined ||
                h.reservedAmount === null
            ) {
                set.reservedAmount = 0;
            }

            if (
                h.billingFinalized === undefined ||
                h.billingFinalized === null
            ) {
                set.billingFinalized =
                    h.status === 'completed' ||
                    h.status === 'failed' ||
                    h.status === 'no-answer' ||
                    h.status === 'cancelled';
            }

            if (!h.billingVersion) {
                set.billingVersion =
                    'legacy';
            }

            if (
                h.status === undefined ||
                h.status === null
            ) {
                set.status =
                    'completed';
            }

            if (
                h.date === undefined ||
                h.date === null
            ) {
                set.date =
                    h.createdAt ||
                    new Date();
            }

            if (
                h.startedAt === undefined ||
                h.startedAt === null
            ) {
                set.startedAt =
                    h.createdAt ||
                    h.date ||
                    new Date();
            }

            if (
                h.callSid === undefined
            ) {
                set.callSid = null;
            }

            if (
                h.answeredAt === undefined
            ) {
                set.answeredAt = null;
            }

            if (
                h.endedAt === undefined
            ) {
                set.endedAt = null;
            }

            if (
                h.edesyData === undefined
            ) {
                set.edesyData = null;
            }

            if (
                Object.keys(set).length > 0
            ) {
                await collection.updateOne(
                    {
                        _id: h._id
                    },
                    {
                        $set: set
                    }
                );

                historyUpdates++;
            }
        }

        console.log(
            `Legacy call histories updated: ${historyUpdates}`
        );

        console.log(
            'Existing user balances were NOT modified.'
        );

        console.log(
            'Legacy minutes were NOT converted into balance.'
        );

        console.log(
            'Old call costs were NOT repriced.'
        );
    } catch (error) {
        console.error(
            'Migration error:',
            error.message
        );
    }
}

async function applyOneTimeBalanceCorrection() {
    const email =
        process.env.BALANCE_CORRECTION_EMAIL;

    const amount =
        Number(
            process.env.BALANCE_CORRECTION_AMOUNT
        );

    if (
        !email ||
        !Number.isFinite(amount) ||
        amount <= 0
    ) {
        return;
    }

    const key =
        `balance_correction_${email.toLowerCase().trim()}_${amount}`;

    const flags =
        mongoose.connection.collection(
            'migration_flags'
        );

    const alreadyApplied =
        await flags.findOne({
            key
        });

    if (alreadyApplied) {
        console.log(
            'Balance correction already applied.'
        );

        return;
    }

    const user =
        await User.findOne({
            email:
                email.toLowerCase().trim()
        });

    if (!user) {
        console.log(
            'Balance correction user not found.'
        );

        return;
    }

    const currentBalance =
        roundMoney(
            user.balance
        );

    const correction =
        roundMoney(
            Math.min(
                amount,
                currentBalance
            )
        );

    if (correction <= 0) {
        return;
    }

    const updatedUser =
        await User.findOneAndUpdate(
            {
                _id: user._id,
                balance: {
                    $gte: correction
                }
            },
            {
                $inc: {
                    balance:
                        -correction
                }
            },
            {
                new: true
            }
        );

    if (!updatedUser) {
        return;
    }

    await flags.insertOne({
        key,
        userId:
            user._id,
        amount:
            correction,
        createdAt:
            new Date()
    });

    console.log(
        `One-time balance correction applied: ₹${correction}`
    );
}

async function startServer() {
    try {
        await mongoose.connect(
            process.env.MONGO_URI
        );

        console.log(
            'MongoDB Connected'
        );

        await migrateDatabase();

        await applyOneTimeBalanceCorrection();

        app.listen(
            PORT,
            () => {
                console.log(
                    `Server running on port ${PORT}`
                );

                console.log(
                    `Environment: ${
                        process.env.NODE_ENV ||
                        'development'
                    }`
                );

                console.log(
                    `User Rate: ₹${CALL_RATE_PER_MINUTE}/minute + 18% GST = ₹${USER_RATE_WITH_GST}/minute`
                );

                console.log(
                    `Edesy Rate: ₹${COMMISSION_PER_MINUTE}/minute + 18% GST = ₹${EDESY_RATE_WITH_GST}/minute`
                );

                console.log(
                    'Safe balance migration enabled.'
                );
            }
        );
    } catch (error) {
        console.error(
            'MongoDB Connection Error:',
            error.message
        );

        process.exit(1);
    }
}

startServer();