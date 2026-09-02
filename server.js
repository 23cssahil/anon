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

if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is not defined in .env file');
    process.exit(1);
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
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
    validate: { trustProxy: false },
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

const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'OTP bahut jaldi bheja diya gaya. Kripya baad mein try karein.'
    }
});

const verifyOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many OTP verification attempts. Please try again later.'
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
const COMMISSION_PER_MINUTE = 1.50;
const ACTUAL_RATE_PER_MINUTE = CALL_RATE_PER_MINUTE;

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    const token = authHeader &&
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

userSchema.index({ createdAt: -1 });
userSchema.index({ email: 1, googleId: 1 });

const User = mongoose.model('User', userSchema);

const callSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
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

    durationMinutes: {
        type: Number,
        required: true,
        min: 1
    },

    durationSeconds: {
        type: Number,
        required: true,
        min: 0
    },

    cost: {
        type: Number,
        required: true,
        min: 3
    },

    clientIp: {
        type: String
    },

    userAgent: {
        type: String
    },

    date: {
        type: Date,
        default: Date.now,
        index: true
    }
});

callSchema.index({ userId: 1, date: -1 });
callSchema.index({ date: -1 });

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
            const amount =
                Number(req.body.amount);

            if (
                !Number.isFinite(amount) ||
                amount <= 0 ||
                amount > 100000
            ) {
                return res.status(400).json({
                    error:
                        'Valid recharge amount required'
                });
            }

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
                    amount
                ).toFixed(2)
            );

            await user.save();

            res.json({
                success: true,
                message:
                    'Development recharge successful.',
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
                user.balance <
                    ACTUAL_RATE_PER_MINUTE
            ) {
                return res.status(400).json({
                    error:
                        `Wallet balance khatam! Kripya recharge karein (Minimum ₹${ACTUAL_RATE_PER_MINUTE} required).`
                });
            }

            let maxAllowedMinutes =
                Math.floor(
                    user.balance /
                    ACTUAL_RATE_PER_MINUTE
                );

            if (
                maxAllowedMinutes < 1
            ) {
                maxAllowedMinutes = 1;
            }

            let durationLimitMinutes =
                maxAllowedMinutes;

            if (
                maxDuration !==
                    undefined &&
                maxDuration !== null &&
                maxDuration !== '' &&
                maxDuration !==
                    'unlimited'
            ) {
                const requestedMins =
                    Number(maxDuration);

                if (
                    !Number.isInteger(
                        requestedMins
                    ) ||
                    requestedMins < 1 ||
                    requestedMins > 60
                ) {
                    return res.status(400).json({
                        error:
                            'Maximum duration must be between 1 and 60 minutes.'
                    });
                }

                durationLimitMinutes =
                    Math.min(
                        requestedMins,
                        maxAllowedMinutes
                    );
            }

            if (
                !process.env.EDESY_API_KEY
            ) {
                return res.status(500).json({
                    error:
                        'Server configuration error: EDESY_API_KEY missing'
                });
            }

            const formattedPartyA =
                userPhone.startsWith('91')
                    ? userPhone
                    : '91' + userPhone;

            const formattedPartyB =
                phoneNumber.startsWith('91')
                    ? phoneNumber
                    : '91' + phoneNumber;

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
                                formattedPartyB,
                            max_duration:
                                durationLimitMinutes
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
                        'Edesy API error occurred';
                }

                return res.status(400).json({
                    error: errorMsg
                });
            }

            const billedMinutes = 1;

            const callCost = Number(
                (
                    billedMinutes *
                    ACTUAL_RATE_PER_MINUTE
                ).toFixed(2)
            );

            const updatedUser =
                await User.findOneAndUpdate(
                    {
                        _id: userId,
                        balance: {
                            $gte: callCost
                        }
                    },
                    {
                        $inc: {
                            balance:
                                -callCost
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
                    callerPhone:
                        userPhone,
                    targetPhone:
                        phoneNumber,
                    durationMinutes:
                        billedMinutes,
                    durationSeconds:
                        60,
                    cost:
                        callCost,
                    clientIp,
                    userAgent
                });
            } catch (
                historyError
            ) {
                await User.findByIdAndUpdate(
                    userId,
                    {
                        $inc: {
                            balance:
                                callCost
                        }
                    }
                );

                throw historyError;
            }

            res.json({
                success: true,
                message:
                    'Call initiated successfully!',
                remainingBalance:
                    updatedUser.balance,
                durationMinutes:
                    billedMinutes,
                cost:
                    callCost,
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
            let actualSecs =
                Number(
                    h.durationSeconds || 0
                );

            if (
                actualSecs <= 0 &&
                h.durationMinutes > 0
            ) {
                actualSecs =
                    Math.round(
                        h.durationMinutes *
                            60
                    );
            }

            if (
                actualSecs <= 0 &&
                h.cost > 0
            ) {
                actualSecs =
                    Math.round(
                        (
                            h.cost /
                            ACTUAL_RATE_PER_MINUTE
                        ) * 60
                    );
            }

            const billedMinutes =
                actualSecs > 0
                    ? Math.ceil(
                          actualSecs / 60
                      )
                    : 1;

            const exactCost =
                Number(
                    (
                        billedMinutes *
                        ACTUAL_RATE_PER_MINUTE
                    ).toFixed(2)
                );

            if (
                h.cost !== exactCost ||
                h.durationMinutes !==
                    billedMinutes ||
                h.durationSeconds !==
                    actualSecs
            ) {
                h.durationMinutes =
                    billedMinutes;

                h.durationSeconds =
                    actualSecs;

                h.cost =
                    exactCost;

                await h.save();
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
                            ACTUAL_RATE_PER_MINUTE
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
                    `Call Rate: ₹${ACTUAL_RATE_PER_MINUTE}/minute | Commission: ₹${COMMISSION_PER_MINUTE}/minute`
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