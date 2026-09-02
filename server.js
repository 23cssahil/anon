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
    minutes: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const callSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    phoneNumber: String,
    durationMinutes: Number,
    cost: Number,
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

// New API to check real-time pool status for frontend
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

app.post('/auth/google-login', async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        let user = await User.findOne({ googleId });
        
        if (!user) {
            const edesyTotal = await getEdesyBalance();
            const assignedTotal = await getTotalAssignedUserMinutes();
            const availablePool = edesyTotal - assignedTotal;

            let freeMinutes = 0;
            if (availablePool >= 1) {
                freeMinutes = 1;
            }

            user = new User({ email, name, googleId, minutes: freeMinutes });
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
                error: `Recharge blocked! Available pool: ${availablePool} minutes (Aapko chahiye: ${minutesToAdd}).` 
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

        const callCost = Number((durationLimit * 3.00).toFixed(2));

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