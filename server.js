const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const mongoose   = require('mongoose');

const app  = express();
app.use(cors());
app.use(bodyParser.json());

const PORT     = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://tobaccoadmin:88HxN5pDXVXH5csw@tobacco-trace.0qc8mol.mongodb.net/tobaccotrace?retryWrites=true&w=majority&appName=tobacco-trace';
const CSV_FILE = path.join(__dirname, 'bales.csv');

// ─────────────────────────────────────────────
// MONGODB CONNECTION
// ─────────────────────────────────────────────
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// ─────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ─────────────────────────────────────────────
const historySchema = new mongoose.Schema({
    action:    String,
    timestamp: String,
    actor:     String,
    hash:      String,
    details:   String,
}, { _id: false });

const receiptSchema = new mongoose.Schema({
    gross:       Number,
    timbLevy:    Number,
    platformFee: Number,
    netPayout:   Number,
    method:      String,
}, { _id: false });

const baleSchema = new mongoose.Schema({
    id:               { type: String, required: true, unique: true },
    farmerId:         String,
    farmerName:       String,
    variety:          String,
    numberOfBales:    Number,
    weight:           Number,
    weightPerBale:    Number,
    estimatedValue:   Number,
    woodScore:        Number,
    woodWeight:       Number,
    inputs:           [String],
    destination:      String,
    gps:              String,
    curing:           String,
    photoEvidence:    String,
    offlineMode:      Boolean,
    registrationDate: String,
    status:           { type: String, default: 'CREATED' },
    hash:             String,
    currentHash:      String,
    floorPrice:       Number,
    riskLevel:        String,
    riskReason:       String,
    officerAssigned:  String,
    highestBid:       Number,
    highestBidder:    String,
    owner:            String,
    receipt:          receiptSchema,
    history:          [historySchema],
});

const userSchema = new mongoose.Schema({
    id:          { type: String, required: true, unique: true },
    nationalId:  String,
    role:        String,
    name:        String,
    phone:       String,
    region:      String,
    wallet:      { type: Number, default: 0 },
    status:      { type: String, default: 'ACTIVE' },
    homeGPS:     { lat: Number, lon: Number },
});

const Bale = mongoose.model('Bale', baleSchema);
const User = mongoose.model('User', userSchema);

// ─────────────────────────────────────────────
// SEED DEFAULT USERS (runs once if DB is empty)
// ─────────────────────────────────────────────
async function seedUsers() {
    const count = await User.countDocuments();
    if (count === 0) {
        await User.insertMany([
            {
                id: 'G-12345', nationalId: '63-111111-F-12', role: 'FARMER',
                name: 'Tinashe Moyo', phone: '+263771234567', region: 'Harare',
                wallet: 50, status: 'ACTIVE',
                homeGPS: { lat: -17.8248, lon: 31.0530 }
            },
            {
                id: 'TIMB-001', nationalId: '00-000000-A-00', role: 'ADMIN',
                name: 'TIMB Officer', wallet: 0, status: 'ACTIVE'
            },
            {
                id: 'BAT-001', nationalId: '99-999999-B-99', role: 'BUYER',
                name: 'BAT Zimbabwe', wallet: 50000, status: 'ACTIVE'
            }
        ]);
        console.log('✅ Default users seeded');
    }
}
seedUsers();

// ─────────────────────────────────────────────
// CSV HELPERS
// ─────────────────────────────────────────────
const CSV_HEADERS = [
    'Batch ID', 'Farmer ID', 'Farmer Name', 'Variety', 'Number of Bales',
    'Total Weight (kg)', 'Weight per Bale (kg)', 'Estimated Value ($)',
    'Wood Weight (kg)', 'Wood Score', 'Curing Method', 'Floor Price ($)',
    'Destination', 'GPS Coordinates', 'Inputs Declared', 'Photo Evidence',
    'Risk Level', 'Risk Reason', 'Officer Assigned', 'Status',
    'Registration Date', 'Genesis Hash'
];

function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    const str = Array.isArray(val) ? val.join(' | ') : String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
}

function appendBaleToCSV(bale) {
    try {
        if (!fs.existsSync(CSV_FILE))
            fs.writeFileSync(CSV_FILE, CSV_HEADERS.join(',') + '\n');
        const row = [
            bale.id, bale.farmerId, bale.farmerName, bale.variety,
            bale.numberOfBales, bale.weight, bale.weightPerBale, bale.estimatedValue,
            bale.woodWeight, bale.woodScore, bale.curing, bale.floorPrice,
            bale.destination, bale.gps || 'OFFLINE', (bale.inputs || []).join(' | '),
            bale.photoEvidence, bale.riskLevel, bale.riskReason, bale.officerAssigned,
            bale.status, bale.registrationDate ? new Date(bale.registrationDate).toLocaleDateString() : '',
            bale.hash,
        ].map(escapeCSV).join(',');
        fs.appendFileSync(CSV_FILE, row + '\n');
        console.log(`📄 Bale ${bale.id} appended to CSV`);
    } catch (err) { console.error('CSV write error:', err); }
}

// ─────────────────────────────────────────────
// OTHER HELPERS
// ─────────────────────────────────────────────
function generateBaleId(farmerId) {
    const date    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random  = Math.random().toString(36).substring(2, 6).toUpperCase();
    const cleanId = farmerId.replace(/-/g, '');
    return `BALE-${cleanId}-${date}-${random}`;
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
        Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function generateHash(previousHash, payload) {
    return crypto.createHash('sha256')
        .update(`${previousHash}-${JSON.stringify(payload)}-${Date.now()}`)
        .digest('hex');
}

// ─────────────────────────────────────────────
// KEEP ALIVE
// ─────────────────────────────────────────────
setInterval(() => {
    const https = require('https');
    https.get('https://tobacco-trace-backend.onrender.com/api/bales', () => {
        console.log('🔄 Keep-alive ping sent');
    }).on('error', () => {});
}, 14 * 60 * 1000);

// ─────────────────────────────────────────────
// POST /api/login
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    try {
        const { growerId, nationalId } = req.body;
        const user = await User.findOne({ id: growerId, nationalId });
        if (user) {
            res.json({ success: true, user });
        } else {
            res.status(401).json({ success: false, error: 'Invalid Credentials' });
        }
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────
// GET /api/bales/export
// ─────────────────────────────────────────────
app.get('/api/bales/export', (req, res) => {
    if (!fs.existsSync(CSV_FILE))
        return res.status(404).json({ error: 'No CSV file found yet.' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="TobaccoTrace_Bales_${new Date().toISOString().slice(0,10)}.csv"`);
    fs.createReadStream(CSV_FILE).pipe(res);
});

// ─────────────────────────────────────────────
// GET /api/bales
// ─────────────────────────────────────────────
app.get('/api/bales', async (req, res) => {
    try {
        const bales = await Bale.find({});
        res.json(bales);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────
// POST /api/bale
// ─────────────────────────────────────────────
app.post('/api/bale', async (req, res) => {
    try {
        const {
            farmer, variety, numberOfBales, weight, estimatedValue,
            woodWeight, gps, curing, woodScore, inputs, destination,
            destinationOther, offlineMode, photoHash
        } = req.body;

        const id   = generateBaleId(farmer);
        const user = await User.findOne({ id: farmer });

        let riskLevel       = 'LOW';
        let riskReason      = 'Verified Origin';
        let officerAssigned = 'None';

        const parsedWeight     = parseFloat(weight) || 0;
        const parsedWoodWeight = parseFloat(woodWeight) || 0;
        const parsedBales      = parseInt(numberOfBales) || 1;
        const parsedInputs     = Array.isArray(inputs) ? inputs : [];
        const registrationDate = new Date().toISOString();
        const finalDestination = destination === 'Other'
            ? (destinationOther || 'Unspecified')
            : (destination || 'Unspecified');

        const parsedWood = parsedWoodWeight > 0 && parsedWeight > 0
            ? parseFloat(((parsedWoodWeight / parsedWeight) * 100).toFixed(1))
            : parseInt(woodScore) || 0;

        // Pricing
        const baseValue = parsedWeight * 3.00;
        let greenBonus = 0, curingPenalty = 0;
        switch (curing) {
            case 'Solar/Air-Cured':  greenBonus = 25; break;
            case 'Gas-Cured':        greenBonus = 15; break;
            case 'Sustainable Wood': greenBonus = parsedWood <= 15 ? 20 : 0; break;
            case 'Dark Fire-Cured':  greenBonus = 10; break;
            case 'Coal':             curingPenalty = 15; break;
        }
        const floorPrice = parseFloat((baseValue + greenBonus - curingPenalty).toFixed(2));

        // Harare region exemption for demo
        const isHarareRegion = gps && (() => {
            const [lat, lon] = gps.split(',').map(Number);
            return lat >= -18.0 && lat <= -17.5 && lon >= 30.8 && lon <= 31.3;
        })();

        // Risk engine
        if (offlineMode) {
            riskLevel = 'MEDIUM'; riskReason = 'Offline Farmer (No Photo Evidence)';
            officerAssigned = 'PENDING DISPATCH (Local Agritex)';
        } else {
            if (gps && user && user.homeGPS && !isHarareRegion) {
                const [currLat, currLon] = gps.split(',').map(Number);
                const distance = getDistance(currLat, currLon, user.homeGPS.lat, user.homeGPS.lon);
                if (distance > 5) {
                    riskLevel = 'HIGH';
                    riskReason = `GEO-FRAUD: Bale registered ${distance.toFixed(2)}km away from farm.`;
                    officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
                }
            }
            if (parsedWood > 0 && (parsedWeight / parsedWood) > 20) {
                riskLevel = 'HIGH';
                riskReason = `Discrepancy: ${parsedWeight}kg yield impossible with Wood Score ${parsedWood}`;
                officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
            } else if (gps && gps.includes('-16.8')) {
                riskLevel = 'HIGH'; riskReason = 'Geographic Hotspot (Karoi Zone 4)';
                officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
            }
            if (parsedWoodWeight > 0 && parsedWoodWeight > parsedWeight * 1.5) {
                riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
                riskReason = `Wood Weight Anomaly: ${parsedWoodWeight}kg wood for ${parsedWeight}kg tobacco`;
                if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Agritex)';
            }
            if (curing === 'Coal') {
                riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
                riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '') + 'Coal Curing: High-emission method.';
                if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Environmental Officer)';
            }
            if (curing === 'Dark Fire-Cured' && parsedWood > 20) {
                riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
                riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '') + `Dark Fire-Cured: Wood score ${parsedWood} exceeds threshold.`;
                if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Forestry Commission)';
            }
            if (curing === 'Sustainable Wood' && parsedWood > 30) {
                riskLevel = 'HIGH';
                riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '') + `Wood score ${parsedWood} exceeds non-compliance threshold of 30.`;
                officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
            }
        }

        const genesisHash = crypto.createHash('sha256')
            .update(`GENESIS-${id}-${farmer}-${registrationDate}`).digest('hex');
        const chemSummary = parsedInputs.length > 0 ? parsedInputs.join(', ') : 'None declared';

        const bale = new Bale({
            id, farmerId: farmer, farmerName: user ? user.name : farmer,
            variety, numberOfBales: parsedBales, weight: parsedWeight,
            weightPerBale: parsedBales > 0 ? parseFloat((parsedWeight / parsedBales).toFixed(2)) : parsedWeight,
            estimatedValue: parseFloat(estimatedValue) || 0,
            woodScore: parsedWood, woodWeight: parsedWoodWeight,
            inputs: parsedInputs, destination: finalDestination,
            gps, curing, photoEvidence: photoHash || 'None',
            offlineMode: !!offlineMode, registrationDate,
            status: 'CREATED', hash: genesisHash, currentHash: genesisHash,
            floorPrice, riskLevel, riskReason, officerAssigned,
            history: [{
                action: 'REGISTERED_AT_FARM', timestamp: registrationDate,
                actor: farmer, hash: genesisHash,
                details: `Origin: ${gps || 'Offline'} | Batch: ${parsedBales} bales @ ${parsedWeight}kg | Curing: ${curing} | Green Bonus: $${greenBonus} | Penalty: -$${curingPenalty} | Destination: ${finalDestination} | Inputs: ${chemSummary}`
            }]
        });

        await bale.save();
        appendBaleToCSV(bale);
        res.json({ message: 'Bale Registered.', riskLevel, floorPrice, baleId: id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error during bale registration' });
    }
});

// ─────────────────────────────────────────────
// POST /api/bid
// ─────────────────────────────────────────────
app.post('/api/bid', async (req, res) => {
    try {
        const { baleId, buyerId, amount } = req.body;
        const bale = await Bale.findOne({ id: baleId });

        if (!bale || bale.status === 'SOLD')
            return res.status(400).json({ error: 'Unavailable' });
        if (amount < bale.floorPrice)
            return res.status(400).json({ error: `Bid rejected by Smart Contract. Must be at least $${bale.floorPrice}` });

        const buyer = await User.findOne({ id: buyerId });
        if (!buyer || buyer.wallet < amount)
            return res.status(400).json({ error: 'Insufficient Funds' });

        const newBidHash = generateHash(bale.currentHash, { amount, buyerId });
        bale.history.push({
            action: 'BID_PLACED', timestamp: new Date().toISOString(),
            actor: buyerId, hash: newBidHash,
            details: `Bid Amount: $${amount}`
        });
        bale.currentHash   = newBidHash;
        bale.highestBid    = amount;
        bale.highestBidder = buyerId;
        bale.status        = 'ON_AUCTION';
        await bale.save();
        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────
// POST /api/accept
// ─────────────────────────────────────────────
app.post('/api/accept', async (req, res) => {
    try {
        const { baleId, farmerId } = req.body;
        const bale = await Bale.findOne({ id: baleId });

        if (!bale || (bale.farmerId !== farmerId && bale.farmer !== farmerId) || !bale.highestBid)
            return res.status(400).json({ error: 'Invalid operation' });
        if (bale.woodScore > 30) {
            bale.status = 'NON_COMPLIANT';
            await bale.save();
            return res.status(400).json({ success: false, error: 'ENVIRONMENTAL COMPLIANCE FAILED.' });
        }
        if (bale.riskLevel === 'HIGH' && bale.officerAssigned && bale.officerAssigned.includes('PENDING'))
            return res.status(400).json({ success: false, error: 'LOCKED: Pending physical verification.' });

        const price       = parseInt(bale.highestBid);
        const timbLevy    = parseFloat((price * 0.015).toFixed(2));
        const platformFee = parseFloat((price * 0.005).toFixed(2));
        const netPayout   = parseFloat((price - timbLevy - platformFee).toFixed(2));

        await User.findOneAndUpdate({ id: bale.highestBidder }, { $inc: { wallet: -price } });
        await User.findOneAndUpdate({ id: farmerId },           { $inc: { wallet: netPayout } });

        const finalHash = generateHash(bale.currentHash, { netPayout, buyer: bale.highestBidder });
        bale.history.push({
            action: 'SMART_CONTRACT_SETTLED', timestamp: new Date().toISOString(),
            actor: 'SYSTEM ORACLE', hash: finalHash,
            details: `Funds disbursed to EcoCash. Net: $${netPayout}. TIMB Levies: $${timbLevy}. Platform Fee: $${platformFee}.`
        });
        bale.currentHash = finalHash;
        bale.status      = 'SOLD';
        bale.owner       = bale.highestBidder;
        bale.receipt     = { gross: price, timbLevy, platformFee, netPayout, method: 'EcoCash Mobile Money' };
        await bale.save();

        res.json({ success: true, message: `Payment Disbursed via EcoCash! Net Payout: $${netPayout}` });

    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 TOBACCO TRACE RUNNING ON PORT ${PORT}`));