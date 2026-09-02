const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not defined in .env file');
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not defined in .env file');
    process.exit(1);
}

if (!process.env.EDESY_API_KEY) {
    console.error('EDESY_API_KEY is not defined in .env file');
    process.exit(1);
}

app.set('trust proxy', 1);

app.use(express.json({
    limit: '100kb'
}));

app.use(cors());

app.use(express.static('public'));

app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

const callLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    validate: {
        trustProxy: false
    },
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

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    const token =
        authHeader &&
        authHeader.startsWith('Bearer ')
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
        Math.floor(Number(actualDurationSeconds) || 0)
    );

    const billableMinutes =
        seconds > 0
            ? Math.ceil(seconds / 60)
            : 0;

    const baseCost = Number(
        (
            billableMinutes *
            CALL_RATE_PER_MINUTE
        ).toFixed(2)
    );

    const gstAmount = Number(
        (
            baseCost *
            GST_RATE
        ).toFixed(2)
    );

    const totalCost = Number(
        (
            baseCost +
            gstAmount
        ).toFixed(2)
    );

    const providerBaseCost = Number(
        (
            billableMinutes *
            COMMISSION_PER_MINUTE
        ).toFixed(2)
    );

    const providerGst = Number(
        (
            providerBaseCost *
            GST_RATE
        ).toFixed(2)
    );

    const providerTotalCost = Number(
        (
            providerBaseCost +
            providerGst
        ).toFixed(2)
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

const User = mongoose.model(
    'User',
    userSchema
);

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

async function getEdesyBalance() {
    return 0;
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

        const edesyTotalRupees = Number(
            (
                edesyTotalMins *
                COMMISSION_PER_MINUTE
            ).toFixed(2)
        );

        const assignedRupees =
            await getTotalAssignedPoolRupees();

        const availablePoolRupees = Math.max(
            0,
            Number(
                (
                    edesyTotalRupees -
                    assignedRupees
                ).toFixed(2)
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

                if (
                    !user.termsAccepted &&
                    termsAccepted
                ) {
                    user.termsAccepted = true;
                    user.termsAcceptedAt =
                        new Date();

                    changed = true;
                }

                if (changed) {
                    await user.save();
                }
            }

            const token = jwt.sign(
                {
                    userId:
                        user._id.toString(),
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
                    balance: user.balance,
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
                error: 'Server error during login'
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
            const baseAmount =
                Number(req.body.amount);

            if (
                !Number.isFinite(baseAmount) ||
                baseAmount <= 0 ||
                baseAmount > 100000
            ) {
                return res.status(400).json({
                    error:
                        'Valid recharge amount required'
                });
            }

            const gstAmount = Number(
                (
                    baseAmount *
                    GST_RATE
                ).toFixed(2)
            );

            const totalAmount = Number(
                (
                    baseAmount +
                    gstAmount
                ).toFixed(2)
            );

            if (
                process.env.NODE_ENV ===
                'production'
            ) {
                return res.status(503).json({
                    error:
                        'Recharge is temporarily unavailable until payment verification is configured.'
                });
            }

            const user =
                await User.findById(
                    req.user.userId
                );

            if (!user) {
                return res.status(404).json({
                    error: 'User not found'
                });
            }

            user.balance = Number(
                (
                    user.balance +
                    baseAmount
                ).toFixed(2)
            );

            await user.save();

            res.json({
                success: true,
                message:
                    'Development recharge successful.',
                baseAmount,
                gstAmount,
                totalAmount,
                creditedAmount:
                    baseAmount,
                newBalance:
                    user.balance
            });
        } catch (error) {
            console.error(
                'Recharge error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Server error during recharge'
            });
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
                balance: user.balance,
                name: user.name,
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

app.post(
    '/api/call',
    authenticateToken,
    callLimiter,
    async (req, res) => {
        try {
            const phoneNumber =
                String(
                    req.body.phoneNumber ||
                    ''
                ).trim();

            const userPhone =
                String(
                    req.body.userPhone ||
                    ''
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
                await User.findById(
                    userId
                );

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
                !Number.isFinite(
                    user.balance
                ) ||
                user.balance < USER_RATE_WITH_GST
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
                    !Number.isInteger(
                        requestedMins
                    ) ||
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

            const reserveAmount =
                Number(
                    (
                        durationLimitMinutes *
                        USER_RATE_WITH_GST
                    ).toFixed(2)
                );

            const formattedPartyA =
                userPhone;

            const formattedPartyB =
                phoneNumber;

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
                        body: JSON.stringify({
                            party_a:
                                formattedPartyA,
                            party_b:
                                formattedPartyB
                        })
                    }
                );

            let edesyData = null;

            try {
                edesyData =
                    await edesyResponse.json();
            } catch {
                edesyData = null;
            }

            if (!edesyResponse.ok) {
                let errorMsg =
                    'Call initiation failed';

                if (
                    edesyData &&
                    typeof edesyData ===
                        'object'
                ) {
                    errorMsg =
                        edesyData.message ||
                        edesyData.error ||
                        edesyData.data?.message ||
                        'Edesy API error occurred';
                }

                return res.status(400).json({
                    error: errorMsg,
                    edesy:
                        edesyData
                });
            }

            const callSid =
                edesyData?.call_sid ||
                edesyData?.data?.call_sid ||
                edesyData?.callSid ||
                edesyData?.data?.callSid ||
                null;

            if (!callSid) {
                return res.status(502).json({
                    error:
                        'Edesy did not return a call_sid. Call was not billed.'
                });
            }

            const updatedUser =
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

            if (!updatedUser) {
                return res.status(400).json({
                    error:
                        'Insufficient wallet balance.'
                });
            }

            const clientIp =
                getClientIp(req);

            const userAgent =
                req.headers[
                    'user-agent'
                ] || 'Unknown';

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

                throw historyError;
            }

            res.json({
                success: true,
                message:
                    'Call initiated successfully!',
                callSid,
                remainingBalance:
                    updatedUser.balance,
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
        null
    );
}

function extractDurationSeconds(payload) {
    const values = [
        payload?.duration_seconds,
        payload?.durationSeconds,
        payload?.call_duration,
        payload?.callDuration,
        payload?.duration,
        payload?.data?.duration_seconds,
        payload?.data?.durationSeconds,
        payload?.data?.call_duration,
        payload?.data?.callDuration,
        payload?.data?.duration,
        payload?.call?.duration_seconds,
        payload?.call?.durationSeconds,
        payload?.call?.call_duration,
        payload?.call?.callDuration,
        payload?.call?.duration
    ];

    for (const value of values) {
        const seconds = Number(value);

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
        eventName.includes('noanswer')
    ) {
        return 'no-answer';
    }

    if (
        eventName.includes('failed') ||
        eventName.includes('failure')
    ) {
        return 'failed';
    }

    if (
        eventName.includes('cancel')
    ) {
        return 'cancelled';
    }

    if (
        eventName.includes('answered') ||
        eventName.includes('bridged')
    ) {
        return 'answered';
    }

    if (
        eventName.includes('ring')
    ) {
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

    if (!secret) {
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
        req.rawBody ||
        JSON.stringify(req.body);

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
                normalizedReceived
            ),
            Buffer.from(expected)
        );
    } catch {
        return false;
    }
}

app.post(
    '/api/webhooks/edesy',
    express.raw({
        type: 'application/json',
        limit: '100kb'
    }),
    async (req, res) => {
        try {
            const rawBody =
                Buffer.isBuffer(req.body)
                    ? req.body.toString('utf8')
                    : JSON.stringify(req.body);

            req.rawBody = rawBody;

            try {
                req.body =
                    JSON.parse(rawBody);
            } catch {
                return res.status(400).json({
                    error:
                        'Invalid webhook JSON'
                });
            }

            if (
                process.env.EDESY_WEBHOOK_SECRET &&
                !verifyEdesyWebhook(req)
            ) {
                return res.status(401).json({
                    error:
                        'Invalid webhook signature'
                });
            }

            const payload =
                req.body;

            const callSid =
                extractCallSid(payload);

            if (!callSid) {
                return res.status(400).json({
                    error:
                        'call_sid missing'
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

            const status =
                extractStatus(payload);

            const durationSeconds =
                extractDurationSeconds(
                    payload
                );

            if (
                status === 'completed' ||
                status === 'failed' ||
                status === 'no-answer' ||
                status === 'cancelled'
            ) {
                if (
                    history.billingFinalized
                ) {
                    return res.json({
                        success: true,
                        alreadyFinalized:
                            true
                    });
                }

                const billing =
                    durationSeconds > 0
                        ? calculateBilling(
                              durationSeconds
                          )
                        : {
                              actualDurationSeconds: 0,
                              billableMinutes: 0,
                              baseCost: 0,
                              gstAmount: 0,
                              totalCost: 0,
                              providerBaseCost: 0,
                              providerGst: 0,
                              providerTotalCost: 0
                          };

                const finalCharge =
                    Math.min(
                        billing.totalCost,
                        history.reservedAmount
                    );

                const refund =
                    Number(
                        (
                            history.reservedAmount -
                            finalCharge
                        ).toFixed(2)
                    );

                if (refund > 0) {
                    await User.findByIdAndUpdate(
                        history.userId,
                        {
                            $inc: {
                                balance:
                                    refund
                            }
                        }
                    );
                }

                history.status =
                    status;

                history.durationSeconds =
                    billing.actualDurationSeconds;

                history.durationMinutes =
                    billing.billableMinutes;

                history.baseCost =
                    billing.baseCost;

                history.gstAmount =
                    billing.gstAmount;

                history.cost =
                    finalCharge;

                history.providerBaseCost =
                    billing.providerBaseCost;

                history.providerGst =
                    billing.providerGst;

                history.providerTotalCost =
                    billing.providerTotalCost;

                history.endedAt =
                    new Date();

                history.billingFinalized =
                    true;

                history.edesyData =
                    payload;

                await history.save();
            } else {
                if (status) {
                    history.status =
                        status;
                }

                if (
                    status === 'answered'
                ) {
                    history.answeredAt =
                        history.answeredAt ||
                        new Date();
                }

                history.edesyData =
                    payload;

                await history.save();
            }

            return res.json({
                success: true
            });
        } catch (error) {
            console.error(
                'Edesy webhook error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Webhook processing failed'
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
        'Invalid PORT in .env'
    );

    process.exit(1);
}

async function migrateDatabase() {
    try {
        const histories =
            await CallHistory.find({});

        for (const h of histories) {
            if (
                h.billingFinalized
            ) {
                continue;
            }

            const actualSecs =
                Number(
                    h.durationSeconds || 0
                );

            if (
                actualSecs > 0
            ) {
                const billing =
                    calculateBilling(
                        actualSecs
                    );

                h.durationMinutes =
                    billing.billableMinutes;

                h.durationSeconds =
                    billing.actualDurationSeconds;

                h.baseCost =
                    billing.baseCost;

                h.gstAmount =
                    billing.gstAmount;

                h.cost =
                    billing.totalCost;

                h.providerBaseCost =
                    billing.providerBaseCost;

                h.providerGst =
                    billing.providerGst;

                h.providerTotalCost =
                    billing.providerTotalCost;

                h.billingFinalized =
                    true;

                await h.save();
            } else {
                if (
                    h.durationMinutes > 0 &&
                    h.cost > 0
                ) {
                    const legacyMinutes =
                        Number(
                            h.durationMinutes
                        );

                    const legacyBase =
                        Number(
                            (
                                legacyMinutes *
                                CALL_RATE_PER_MINUTE
                            ).toFixed(2)
                        );

                    const legacyGst =
                        Number(
                            (
                                legacyBase *
                                GST_RATE
                            ).toFixed(2)
                        );

                    h.durationSeconds =
                        legacyMinutes * 60;

                    h.durationMinutes =
                        legacyMinutes;

                    h.baseCost =
                        legacyBase;

                    h.gstAmount =
                        legacyGst;

                    h.cost =
                        Number(
                            (
                                legacyBase +
                                legacyGst
                            ).toFixed(2)
                        );

                    h.providerBaseCost =
                        Number(
                            (
                                legacyMinutes *
                                COMMISSION_PER_MINUTE
                            ).toFixed(2)
                        );

                    h.providerGst =
                        Number(
                            (
                                h.providerBaseCost *
                                GST_RATE
                            ).toFixed(2)
                        );

                    h.providerTotalCost =
                        Number(
                            (
                                h.providerBaseCost +
                                h.providerGst
                            ).toFixed(2)
                        );

                    h.billingFinalized =
                        true;

                    await h.save();
                }
            }
        }

        const users =
            await User.find({});

        for (const user of users) {
            if (
                user.minutes !==
                    undefined &&
                user.minutes > 0 &&
                user.balance === 0
            ) {
                user.balance =
                    Number(
                        (
                            user.minutes *
                            USER_RATE_WITH_GST
                        ).toFixed(2)
                    );

                user.minutes =
                    undefined;

                await user.save();
            }
        }

        console.log(
            'Database migration completed.'
        );
    } catch (error) {
        console.error(
            'Migration error:',
            error.message
        );
    }
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