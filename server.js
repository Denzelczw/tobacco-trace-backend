const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- SETUP ---
const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'database.json');

// --- DEFAULT DATA ---
const defaultData = {
    ledger: {
        'BALE_INIT_001': { 
            id: 'BALE_INIT_001', farmer: 'G-12345', variety: 'Virginia', 
            weight: 100, gps: '-17.8216, 31.0492', curing: 'Sustainable Wood', 
            woodScore: 15, status: 'CREATED', hash: 'GENESIS_BLOCK_HASH',
            riskLevel: 'LOW', riskReason: 'None', officerAssigned: 'None'
        }
    },
    users: [
        { id: 'G-12345', nationalId: '63-111111-F-12', role: 'FARMER', name: 'Tinashe (Farmer)', wallet: 50 },
        { id: 'TIMB-001', nationalId: '00-000000-A-00', role: 'ADMIN', name: 'TIMB Officer', wallet: 0 },
        { id: 'BAT-001', nationalId: '99-999999-B-99', role: 'BUYER', name: 'BAT Zimbabwe', wallet: 50000 }
    ]
};

function loadDatabase() {
    try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (err) { console.error(err); }
    saveDatabase(defaultData); return defaultData;
}

function saveDatabase(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } 
    catch (err) { console.error(err); }
}

let db = loadDatabase();

// --- API ENDPOINTS ---

app.post('/api/login', (req, res) => {
    const { growerId, nationalId } = req.body;
    const user = db.users.find(u => u.id === growerId && u.nationalId === nationalId);
    if (user) res.json({ success: true, user }); 
    else res.status(401).json({ success: false, error: 'Invalid Credentials' });
});

// --- UPGRADED: CREATE BALE WITH RISK ENGINE ---
app.post('/api/bale', (req, res) => {
    const { id, farmer, variety, weight, gps, curing, woodScore, offlineMode, photoHash } = req.body;
    
    if (db.ledger[id]) return res.status(400).json({ error: 'Bale ID already exists' });

    let riskLevel = 'LOW';
    let riskReason = 'None';
    let officerAssigned = 'None';
    const parsedWeight = parseFloat(weight) || 0;
    const parsedWood = parseInt(woodScore) || 0;

    // 1. EXTENSION OFFICER TRIGGER (Offline Farmer)
    if (offlineMode) {
        riskLevel = 'MEDIUM';
        riskReason = 'Offline Farmer (No Photo Evidence)';
        officerAssigned = 'PENDING DISPATCH (Local Agritex)';
    } 
    else {
        // 2. ALGORITHMIC DISCREPANCY TRIGGER (Math doesn't add up)
        // E.g., Curing 100kg with a score of 2 is impossible. Ratio > 20 is suspicious.
        if (parsedWood > 0 && (parsedWeight / parsedWood) > 20) {
            riskLevel = 'HIGH';
            riskReason = `Discrepancy: ${parsedWeight}kg yield impossible with Wood Score ${parsedWood}`;
            officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
        }
        // 3. GEOGRAPHIC HOTSPOT TRIGGER (Simulated Karoi Deforestation Zone)
        else if (gps.includes('-16.8')) {
            riskLevel = 'HIGH';
            riskReason = 'Geographic Hotspot (Karoi Zone 4)';
            officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
        }
        // 4. RANDOMIZED SPOT CHECK TRIGGER (10% chance)
        else if (Math.random() < 0.10) {
            riskLevel = 'MEDIUM';
            riskReason = 'Randomized Spot Check';
            officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
        }
    }

    const dataString = `${id}-${farmer}-${gps}-${woodScore}-${parsedWeight}-${photoHash}-${Date.now()}`;
    const txHash = crypto.createHash('sha256').update(dataString).digest('hex');

    db.ledger[id] = { 
        id, farmer, variety, weight: parsedWeight, gps, curing, 
        woodScore: parsedWood, status: 'CREATED', hash: txHash,
        riskLevel, riskReason, officerAssigned, photoEvidence: photoHash || 'None'
    };
    
    saveDatabase(db); 
    res.json({ message: 'Bale Registered. Risk Assessment Complete.' });
});

app.get('/api/bales', (req, res) => { res.json(Object.values(db.ledger)); });

app.post('/api/bid', (req, res) => {
    const { baleId, buyerId, amount } = req.body;
    if (!db.ledger[baleId] || db.ledger[baleId].status === 'SOLD') return res.status(400).json({ error: 'Unavailable' });
    
    const buyer = db.users.find(u => u.id === buyerId);
    if (!buyer || buyer.wallet < amount) return res.status(400).json({ error: 'Insufficient Funds' });

    db.ledger[baleId].highestBid = amount;
    db.ledger[baleId].highestBidder = buyerId;
    db.ledger[baleId].status = 'ON_AUCTION';
    saveDatabase(db);
    res.json({ success: true });
});

app.post('/api/accept', (req, res) => {
    const { baleId, farmerId } = req.body;
    const bale = db.ledger[baleId];

    if (!bale || bale.farmer !== farmerId || !bale.highestBid) return res.status(400).json({ error: 'Invalid operation' });

    // GREEN PREMIUM CHECK (Hard Limit)
    if (bale.woodScore > 30) {
        bale.status = 'NON_COMPLIANT';
        saveDatabase(db);
        return res.status(400).json({ success: false, error: `ENVIRONMENTAL COMPLIANCE FAILED.` });
    }

    // NEW: Cannot sell if under active physical investigation
    if (bale.riskLevel === 'HIGH' && bale.officerAssigned.includes('PENDING')) {
        return res.status(400).json({ success: false, error: `TRANSACTION LOCKED: Pending physical verification by ${bale.officerAssigned}.` });
    }

    const buyerIdx = db.users.findIndex(u => u.id === bale.highestBidder);
    const farmerIdx = db.users.findIndex(u => u.id === farmerId);
    const price = parseInt(bale.highestBid);
    
    db.users[buyerIdx].wallet -= price;       
    db.users[farmerIdx].wallet += price;      

    bale.status = 'SOLD';
    bale.owner = bale.highestBidder;

    const finalDataString = `${baleId}-${bale.owner}-${price}-${Date.now()}`;
    bale.hash = crypto.createHash('sha256').update(finalDataString).digest('hex');

    saveDatabase(db);
    res.json({ success: true, message: `Sold for $${price}!` });
});

app.listen(PORT, () => { console.log(`🚀 TOBACCO TRACE [RISK ENGINE] RUNNING ON PORT ${PORT}`); });