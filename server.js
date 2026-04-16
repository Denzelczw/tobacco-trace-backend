const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'database.json');

const REGION_CODES = {
    'Harare':               'HRE',
    'Bulawayo':             'BYO',
    'Manicaland':           'MAN',
    'Mashonaland Central':  'MSC',
    'Mashonaland East':     'MSE',
    'Mashonaland West':     'MSW',
    'Masvingo':             'MVG',
    'Matabeleland North':   'MTN',
    'Matabeleland South':   'MTS',
    'Midlands':             'MID',
};

const defaultData = {
    ledger: {},
    farmerSequences: {},
    users: [
        {
            id: 'TT-HRE-001',
            nationalId: '63-111111-F-12',
            role: 'FARMER',
            name: 'Tinashe Moyo',
            phone: '+263771234567',
            region: 'Harare',
            wallet: 50,
            status: 'ACTIVE',
            registeredAt: '2025-01-10T00:00:00.000Z',
            homeGPS: { lat: -17.8248, lon: 31.0530 }
        },
        {
            id: 'TIMB-001',
            nationalId: '00-000000-A-00',
            role: 'ADMIN',
            name: 'TIMB Officer',
            wallet: 0,
            status: 'ACTIVE'
        },
        {
            id: 'BAT-001',
            nationalId: '99-999999-B-99',
            role: 'BUYER',
            name: 'BAT Zimbabwe',
            wallet: 50000,
            status: 'ACTIVE'
        }
    ]
};

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) { console.error(err); }
    saveDatabase(defaultData);
    return defaultData;
}

function saveDatabase(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (err) {}
}

let db = loadDatabase();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function generateHash(previousHash, payload) {
    return crypto.createHash('sha256')
        .update(`${previousHash}-${JSON.stringify(payload)}-${Date.now()}`)
        .digest('hex');
}

// ─────────────────────────────────────────────
// POST /api/login
// ─────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    const { growerId, nationalId } = req.body;
    const user = db.users.find(u => u.id === growerId && u.nationalId === nationalId);
    if (user) {
        res.json({ success: true, user });
    } else {
        res.status(401).json({ success: false, error: 'Invalid Credentials' });
    }
});

// ─────────────────────────────────────────────
// POST /api/farmers — TIMB registers a new farmer
// ─────────────────────────────────────────────
app.post('/api/farmers', (req, res) => {
    const { name, nationalId, phone, region, homeGPS } = req.body;

    if (!name || !nationalId || !phone || !region)
        return res.status(400).json({ error: 'Name, National ID, phone and region are required.' });

    if (db.users.find(u => u.nationalId === nationalId))
        return res.status(400).json({ error: 'A farmer with this National ID already exists.' });

    const regionCode = REGION_CODES[region];
    if (!regionCode)
        return res.status(400).json({ error: `Unknown region: ${region}` });

    if (!db.farmerSequences) db.farmerSequences = {};
    db.farmerSequences[regionCode] = (db.farmerSequences[regionCode] || 0) + 1;
    const seq = String(db.farmerSequences[regionCode]).padStart(3, '0');
    const growerId = `TT-${regionCode}-${seq}`;

    const newFarmer = {
        id: growerId,
        nationalId,
        role: 'FARMER',
        name,
        phone,
        region,
        wallet: 0,
        status: 'ACTIVE',
        registeredAt: new Date().toISOString(),
        homeGPS: homeGPS || null,
    };

    db.users.push(newFarmer);
    saveDatabase(db);

    res.json({ success: true, message: 'Farmer registered successfully.', growerId, farmer: newFarmer });
});

// ─────────────────────────────────────────────
// GET /api/farmers — list all farmers
// ─────────────────────────────────────────────
app.get('/api/farmers', (req, res) => {
    const farmers = db.users.filter(u => u.role === 'FARMER').map(f => {
        const baleCount = Object.values(db.ledger).filter(b => b.farmerId === f.id).length;
        const { nationalId, ...safeFarmer } = f;
        return { ...safeFarmer, baleCount };
    });
    res.json(farmers);
});

// ─────────────────────────────────────────────
// POST /api/bale — register a bale
// ─────────────────────────────────────────────
app.post('/api/bale', (req, res) => {
    const {
        id, farmer, variety, numberOfBales, weight, estimatedValue,
        woodWeight, gps, curing, woodScore, inputs, destination,
        destinationOther, offlineMode, photoHash
    } = req.body;

    if (db.ledger[id]) return res.status(400).json({ error: 'Bale ID already exists' });

    const user = db.users.find(u => u.id === farmer);
    let riskLevel = 'LOW';
    let riskReason = 'Verified Origin';
    let officerAssigned = 'None';

    const parsedWeight     = parseFloat(weight) || 0;
    const parsedWoodWeight = parseFloat(woodWeight) || 0;
    const parsedBales      = parseInt(numberOfBales) || 1;
    const parsedInputs     = Array.isArray(inputs) ? inputs : [];
    const registrationDate = new Date().toISOString();
    const finalDestination = destination === 'Other'
        ? (destinationOther || 'Unspecified')
        : (destination || 'Unspecified');

    // Auto-calculate wood score from weights — cannot be spoofed
    const parsedWood = parsedWoodWeight > 0 && parsedWeight > 0
        ? parseFloat(((parsedWoodWeight / parsedWeight) * 100).toFixed(1))
        : parseInt(woodScore) || 0;

    // --- PRICING ALGORITHM (curing-aware) ---
    const baseValue = parsedWeight * 3.00;
    let greenBonus  = 0;
    let curingPenalty = 0;

    switch (curing) {
        case 'Solar/Air-Cured':  greenBonus = 25; break;
        case 'Gas-Cured':        greenBonus = 15; break;
        case 'Sustainable Wood': greenBonus = parsedWood <= 15 ? 20 : 0; break;
        case 'Dark Fire-Cured':  greenBonus = 10; break;
        case 'Coal':             curingPenalty = 15; break;
        default:                 greenBonus = 0;
    }

    const floorPrice = parseFloat((baseValue + greenBonus - curingPenalty).toFixed(2));

    // --- RISK ENGINE ---
    if (offlineMode) {
        riskLevel = 'MEDIUM';
        riskReason = 'Offline Farmer (No Photo Evidence)';
        officerAssigned = 'PENDING DISPATCH (Local Agritex)';
    } else {
        if (gps && user && user.homeGPS) {
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
            riskLevel = 'HIGH';
            riskReason = 'Geographic Hotspot (Karoi Zone 4)';
            officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
        }
        if (parsedWoodWeight > 0 && parsedWoodWeight > parsedWeight * 1.5) {
            riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
            riskReason = `Wood Weight Anomaly: ${parsedWoodWeight}kg wood for ${parsedWeight}kg tobacco`;
            if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Agritex)';
        }
        if (curing === 'Coal') {
            riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
            riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '')
                + 'Coal Curing: High-emission method — floor price reduced by $15.';
            if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Environmental Officer)';
        }
        if (curing === 'Dark Fire-Cured' && parsedWood > 20) {
            riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
            riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '')
                + `Dark Fire-Cured: Wood score ${parsedWood} exceeds threshold of 20.`;
            if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Forestry Commission)';
        }
        if (curing === 'Sustainable Wood' && parsedWood > 30) {
            riskLevel = 'HIGH';
            riskReason = (riskReason !== 'Verified Origin' ? riskReason + ' | ' : '')
                + `Wood score ${parsedWood} exceeds non-compliance threshold of 30.`;
            officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
        }
    }

    // --- TRACEABILITY CHAIN ---
    const genesisHash = crypto.createHash('sha256')
        .update(`GENESIS-${id}-${farmer}-${registrationDate}`)
        .digest('hex');

    const chemSummary = parsedInputs.length > 0 ? parsedInputs.join(', ') : 'None declared';

    db.ledger[id] = {
        id,
        farmerId: farmer,
        farmerName: user ? user.name : farmer,
        variety,
        numberOfBales: parsedBales,
        weight: parsedWeight,
        weightPerBale: parsedBales > 0 ? parseFloat((parsedWeight / parsedBales).toFixed(2)) : parsedWeight,
        estimatedValue: parseFloat(estimatedValue) || 0,
        woodScore: parsedWood,
        woodWeight: parsedWoodWeight,
        inputs: parsedInputs,
        destination: finalDestination,
        gps,
        curing,
        photoEvidence: photoHash || 'None',
        offlineMode: !!offlineMode,
        registrationDate,
        status: 'CREATED',
        hash: genesisHash,
        currentHash: genesisHash,
        floorPrice,
        riskLevel,
        riskReason,
        officerAssigned,
        history: [{
            action: 'REGISTERED_AT_FARM',
            timestamp: registrationDate,
            actor: farmer,
            hash: genesisHash,
            details: `Origin: ${gps || 'Offline'} | Batch: ${parsedBales} bales @ ${parsedWeight}kg | Curing: ${curing} | Green Bonus: $${greenBonus} | Penalty: -$${curingPenalty} | Destination: ${finalDestination} | Inputs: ${chemSummary}`
        }]
    };

    saveDatabase(db);
    res.json({ message: 'Bale Registered.', riskLevel, floorPrice, baleId: id });
});

// ─────────────────────────────────────────────
// GET /api/bales — fetch all bales
// ─────────────────────────────────────────────
app.get('/api/bales', (req, res) => {
    res.json(Object.values(db.ledger));
});

// ─────────────────────────────────────────────
// POST /api/bid — place a bid
// ─────────────────────────────────────────────
app.post('/api/bid', (req, res) => {
    const { baleId, buyerId, amount } = req.body;
    const bale = db.ledger[baleId];

    if (!bale || bale.status === 'SOLD')
        return res.status(400).json({ error: 'Unavailable' });
    if (amount < bale.floorPrice)
        return res.status(400).json({ error: `Bid rejected by Smart Contract. Must be at least $${bale.floorPrice}` });

    const buyer = db.users.find(u => u.id === buyerId);
    if (!buyer || buyer.wallet < amount)
        return res.status(400).json({ error: 'Insufficient Funds' });

    const newBidHash = generateHash(bale.currentHash, { amount, buyerId });
    bale.history.push({
        action: 'BID_PLACED',
        timestamp: new Date().toISOString(),
        actor: buyerId,
        hash: newBidHash,
        details: `Bid Amount: $${amount}`
    });
    bale.currentHash = newBidHash;
    bale.highestBid = amount;
    bale.highestBidder = buyerId;
    bale.status = 'ON_AUCTION';
    saveDatabase(db);
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// POST /api/accept — accept a bid
// ─────────────────────────────────────────────
app.post('/api/accept', (req, res) => {
    const { baleId, farmerId } = req.body;
    const bale = db.ledger[baleId];

    if (!bale || bale.farmerId !== farmerId || !bale.highestBid)
        return res.status(400).json({ error: 'Invalid operation' });
    if (bale.woodScore > 30) {
        bale.status = 'NON_COMPLIANT';
        saveDatabase(db);
        return res.status(400).json({ success: false, error: 'ENVIRONMENTAL COMPLIANCE FAILED.' });
    }
    if (bale.riskLevel === 'HIGH' && bale.officerAssigned.includes('PENDING'))
        return res.status(400).json({ success: false, error: 'LOCKED: Pending physical verification.' });

    const price       = parseInt(bale.highestBid);
    const timbLevy    = parseFloat((price * 0.015).toFixed(2));
    const platformFee = parseFloat((price * 0.005).toFixed(2));
    const netPayout   = parseFloat((price - timbLevy - platformFee).toFixed(2));

    const buyerIdx  = db.users.findIndex(u => u.id === bale.highestBidder);
    const farmerIdx = db.users.findIndex(u => u.id === farmerId);
    db.users[buyerIdx].wallet  -= price;
    db.users[farmerIdx].wallet += netPayout;

    const finalHash = generateHash(bale.currentHash, { netPayout, buyer: bale.highestBidder });
    bale.history.push({
        action: 'SMART_CONTRACT_SETTLED',
        timestamp: new Date().toISOString(),
        actor: 'SYSTEM ORACLE',
        hash: finalHash,
        details: `Funds disbursed to EcoCash. Net: $${netPayout}. TIMB Levies: $${timbLevy}. Platform Fee: $${platformFee}.`
    });
    bale.currentHash = finalHash;
    bale.status      = 'SOLD';
    bale.owner       = bale.highestBidder;
    bale.receipt     = { gross: price, timbLevy, platformFee, netPayout, method: 'EcoCash Mobile Money' };

    saveDatabase(db);
    res.json({ success: true, message: `Payment Disbursed via EcoCash! Net Payout: $${netPayout}` });
});

// ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 TOBACCO TRACE RUNNING ON PORT ${PORT}`));