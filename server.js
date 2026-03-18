const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
// Render assigns a dynamic PORT, so we use process.env.PORT
const PORT = process.env.PORT || 3001; 
const DB_FILE = path.join(__dirname, 'database.json');

const defaultData = {
    ledger: {},
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
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (err) {}
}
let db = loadDatabase();

app.post('/api/login', (req, res) => {
    const { growerId, nationalId } = req.body;
    const user = db.users.find(u => u.id === growerId && u.nationalId === nationalId);
    if (user) res.json({ success: true, user }); else res.status(401).json({ success: false, error: 'Invalid Credentials' });
});

app.post('/api/bale', (req, res) => {
    const { id, farmer, variety, weight, gps, curing, woodScore, offlineMode, photoHash } = req.body;
    if (db.ledger[id]) return res.status(400).json({ error: 'Bale ID already exists' });

    let riskLevel = 'LOW'; let riskReason = 'None'; let officerAssigned = 'None';
    const parsedWeight = parseFloat(weight) || 0;
    const parsedWood = parseInt(woodScore) || 0;

    // --- NEW: TRANSPARENT PRICING ALGORITHM ---
    // Base price: $3.00 per kg.
    // Green Premium: If Wood Score is 15 or below, add a $20 environmental bonus.
    const baseValue = parsedWeight * 3.00;
    const greenBonus = parsedWood <= 15 ? 20 : 0;
    const floorPrice = baseValue + greenBonus;

    if (offlineMode) {
        riskLevel = 'MEDIUM'; riskReason = 'Offline Farmer (No Photo Evidence)'; officerAssigned = 'PENDING DISPATCH (Local Agritex)';
    } else {
        if (parsedWood > 0 && (parsedWeight / parsedWood) > 20) {
            riskLevel = 'HIGH'; riskReason = `Discrepancy: ${parsedWeight}kg yield impossible with Wood Score ${parsedWood}`; officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
        } else if (gps.includes('-16.8')) {
            riskLevel = 'HIGH'; riskReason = 'Geographic Hotspot (Karoi Zone 4)'; officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
        } else if (Math.random() < 0.10) {
            riskLevel = 'MEDIUM'; riskReason = 'Randomized Spot Check'; officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
        }
    }

    const txHash = crypto.createHash('sha256').update(`${id}-${farmer}-${Date.now()}`).digest('hex');

    db.ledger[id] = { 
        id, farmer, variety, weight: parsedWeight, gps, curing, 
        woodScore: parsedWood, status: 'CREATED', hash: txHash,
        riskLevel, riskReason, officerAssigned, photoEvidence: photoHash || 'None',
        floorPrice // Saved to the ledger
    };
    saveDatabase(db); res.json({ message: 'Bale Registered.' });
});

app.get('/api/bales', (req, res) => { res.json(Object.values(db.ledger)); });

app.post('/api/bid', (req, res) => {
    const { baleId, buyerId, amount } = req.body;
    const bale = db.ledger[baleId];
    if (!bale || bale.status === 'SOLD') return res.status(400).json({ error: 'Unavailable' });
    
    // --- NEW: ENFORCE FLOOR PRICE ---
    if (amount < bale.floorPrice) return res.status(400).json({ error: `Bid rejected by Smart Contract. Must be at least $${bale.floorPrice}` });

    const buyer = db.users.find(u => u.id === buyerId);
    if (!buyer || buyer.wallet < amount) return res.status(400).json({ error: 'Insufficient Funds' });

    bale.highestBid = amount;
    bale.highestBidder = buyerId;
    bale.status = 'ON_AUCTION';
    saveDatabase(db); res.json({ success: true });
});

app.post('/api/accept', (req, res) => {
    const { baleId, farmerId } = req.body;
    const bale = db.ledger[baleId];

    if (!bale || bale.farmer !== farmerId || !bale.highestBid) return res.status(400).json({ error: 'Invalid operation' });
    if (bale.woodScore > 30) {
        bale.status = 'NON_COMPLIANT'; saveDatabase(db); return res.status(400).json({ success: false, error: `ENVIRONMENTAL COMPLIANCE FAILED.` });
    }
    if (bale.riskLevel === 'HIGH' && bale.officerAssigned.includes('PENDING')) {
        return res.status(400).json({ success: false, error: `LOCKED: Pending physical verification.` });
    }

    const price = parseInt(bale.highestBid);
    
    // --- NEW: AUTOMATED SETTLEMENT MATHEMATICS ---
    const timbLevy = parseFloat((price * 0.015).toFixed(2)); // 1.5% tax
    const platformFee = parseFloat((price * 0.005).toFixed(2)); // 0.5% system fee
    const netPayout = parseFloat((price - timbLevy - platformFee).toFixed(2));

    const buyerIdx = db.users.findIndex(u => u.id === bale.highestBidder);
    const farmerIdx = db.users.findIndex(u => u.id === farmerId);
    
    db.users[buyerIdx].wallet -= price;       
    db.users[farmerIdx].wallet += netPayout; // Farmer only gets net payout     

    bale.status = 'SOLD';
    bale.owner = bale.highestBidder;
    bale.hash = crypto.createHash('sha256').update(`${baleId}-${bale.owner}-${price}-${Date.now()}`).digest('hex');
    
    // Save the immutable receipt to the ledger
    bale.receipt = { gross: price, timbLevy, platformFee, netPayout, method: 'EcoCash Mobile Money' };

    saveDatabase(db);
    res.json({ success: true, message: `Payment Disbursed via EcoCash! Net Payout: $${netPayout}` });
});

app.listen(PORT, () => { console.log(`🚀 TOBACCO TRACE RUNNING ON PORT ${PORT}`); });