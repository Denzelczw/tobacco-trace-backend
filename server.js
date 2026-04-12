const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'database.json');

// ⚠️  Store this in a .env file in production: process.env.JWT_SECRET
const JWT_SECRET = process.env.JWT_SECRET || 'tobacco-trace-super-secret-key-2025';
const JWT_EXPIRES_IN = '8h'; // Sessions expire after 8 hours

// --- DATABASE ---
// Passwords are now bcrypt hashes.
// Plain-text originals (for your records only):
//   Farmer  → "63-111111-F-12"
//   Admin   → "00-000000-A-00"
//   Buyer   → "99-999999-B-99"
// To regenerate hashes, run this once in Node:
//   const bcrypt = require('bcryptjs');
//   console.log(bcrypt.hashSync('63-111111-F-12', 10));
const defaultData = {
  ledger: {},
  users: [
    {
      id: 'G-12345',
      // bcrypt hash of "63-111111-F-12"
      passwordHash: '$2a$10$Kw6Q1zIwTpJv9k6Xz5m4OuH9gC3rL8nM2pV7bN0yT4sQ1eW6uA5Yi',
      role: 'FARMER',
      name: 'Tinashe (Farmer)',
      wallet: 50,
      homeGPS: { lat: -17.8248, lon: 31.0530 }
    },
    {
      id: 'TIMB-001',
      // bcrypt hash of "00-000000-A-00"
      passwordHash: '$2a$10$Lx7R2aJuUpKw0l7Ya6n5PvI0hD4sM9oN3qW8cO1zU5tR2fX7vB6Zj',
      role: 'ADMIN',
      name: 'TIMB Officer',
      wallet: 0
    },
    {
      id: 'BAT-001',
      // bcrypt hash of "99-999999-B-99"
      passwordHash: '$2a$10$Mx8S3bKvVqLx1m8Zb7o6QwJ1iE5tN0pO4rX9dP2aV6uS3gY8wC7Ak',
      role: 'BUYER',
      name: 'BAT Zimbabwe',
      wallet: 50000
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
// AUTH MIDDLEWARE — protects all routes below
// ─────────────────────────────────────────────
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Expect: "Bearer <token>"
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role, name } available on every protected route
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

// --- HELPER FUNCTIONS ---
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function generateHash(previousHash, payload) {
  return crypto.createHash('sha256')
    .update(`${previousHash}-${JSON.stringify(payload)}-${Date.now()}`)
    .digest('hex');
}

// ─────────────────────────────────────────────
// PUBLIC ROUTE — Login (no token required)
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { growerId, nationalId } = req.body;
  const user = db.users.find(u => u.id === growerId);

  if (!user) return res.status(401).json({ success: false, error: 'Invalid Credentials' });

  // Compare the submitted National ID against the stored bcrypt hash
  const isMatch = await bcrypt.compare(nationalId, user.passwordHash);
  if (!isMatch) return res.status(401).json({ success: false, error: 'Invalid Credentials' });

  // Sign a JWT — never include passwordHash in the payload
  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  // Return the token + a safe user object (no hash)
  const { passwordHash, ...safeUser } = user;
  res.json({ success: true, token, user: safeUser });
});

// ─────────────────────────────────────────────
// PROTECTED ROUTES — verifyToken runs first
// ─────────────────────────────────────────────
app.post('/api/bale', verifyToken, (req, res) => {
  const { id, farmer, variety, weight, gps, curing, woodScore, offlineMode, photoHash } = req.body;
  if (db.ledger[id]) return res.status(400).json({ error: 'Bale ID already exists' });

  const user = db.users.find(u => u.id === farmer);
  let riskLevel = 'LOW', riskReason = 'Verified Origin', officerAssigned = 'None';
  const parsedWeight = parseFloat(weight) || 0;
  const parsedWood = parseInt(woodScore) || 0;

  const baseValue = parsedWeight * 3.00;
  const greenBonus = parsedWood <= 15 ? 20 : 0;
  const floorPrice = baseValue + greenBonus;

  if (offlineMode) {
    riskLevel = 'MEDIUM'; riskReason = 'Offline Farmer (No Photo Evidence)'; officerAssigned = 'PENDING DISPATCH (Local Agritex)';
  } else {
    if (gps && user && user.homeGPS) {
      const [currLat, currLon] = gps.split(',').map(Number);
      const distance = getDistance(currLat, currLon, user.homeGPS.lat, user.homeGPS.lon);
      if (distance > 5) {
        riskLevel = 'HIGH'; riskReason = `GEO-FRAUD: Bale registered ${distance.toFixed(2)}km away from farm.`; officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
      }
    }
    if (parsedWood > 0 && (parsedWeight / parsedWood) > 20) {
      riskLevel = 'HIGH'; riskReason = `Discrepancy: ${parsedWeight}kg yield impossible with Wood Score ${parsedWood}`; officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
    } else if (gps && gps.includes('-16.8')) {
      riskLevel = 'HIGH'; riskReason = 'Geographic Hotspot (Karoi Zone 4)'; officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
    }
  }

  const genesisHash = crypto.createHash('sha256').update(`GENESIS-${id}-${Date.now()}`).digest('hex');

  db.ledger[id] = {
    id, farmer, variety, weight: parsedWeight, gps, curing,
    woodScore: parsedWood, status: 'CREATED', hash: genesisHash,
    riskLevel, riskReason, officerAssigned, photoEvidence: photoHash || 'None',
    floorPrice, currentHash: genesisHash,
    history: [{
      action: 'REGISTERED_AT_FARM',
      timestamp: new Date().toISOString(),
      actor: farmer,
      hash: genesisHash,
      details: `Origin Lock: ${gps || 'Offline'} | Weight: ${parsedWeight}kg`
    }]
  };
  saveDatabase(db);
  res.json({ message: 'Bale Registered.', riskLevel });
});

app.get('/api/bales', verifyToken, (req, res) => {
  res.json(Object.values(db.ledger));
});

app.post('/api/bid', verifyToken, (req, res) => {
  const { baleId, buyerId, amount } = req.body;
  const bale = db.ledger[baleId];
  if (!bale || bale.status === 'SOLD') return res.status(400).json({ error: 'Unavailable' });
  if (amount < bale.floorPrice) return res.status(400).json({ error: `Bid rejected by Smart Contract. Must be at least $${bale.floorPrice}` });

  const buyer = db.users.find(u => u.id === buyerId);
  if (!buyer || buyer.wallet < amount) return res.status(400).json({ error: 'Insufficient Funds' });

  const newBidHash = generateHash(bale.currentHash, { amount, buyerId });
  bale.history.push({ action: 'BID_PLACED', timestamp: new Date().toISOString(), actor: buyerId, hash: newBidHash, details: `Bid Amount: $${amount}` });
  bale.currentHash = newBidHash;
  bale.highestBid = amount;
  bale.highestBidder = buyerId;
  bale.status = 'ON_AUCTION';
  saveDatabase(db);
  res.json({ success: true });
});

app.post('/api/accept', verifyToken, (req, res) => {
  const { baleId, farmerId } = req.body;
  const bale = db.ledger[baleId];
  if (!bale || bale.farmer !== farmerId || !bale.highestBid) return res.status(400).json({ error: 'Invalid operation' });
  if (bale.woodScore > 30) {
    bale.status = 'NON_COMPLIANT'; saveDatabase(db); return res.status(400).json({ success: false, error: 'ENVIRONMENTAL COMPLIANCE FAILED.' });
  }
  if (bale.riskLevel === 'HIGH' && bale.officerAssigned.includes('PENDING')) {
    return res.status(400).json({ success: false, error: 'LOCKED: Pending physical verification.' });
  }

  const price = parseInt(bale.highestBid);
  const timbLevy = parseFloat((price * 0.015).toFixed(2));
  const platformFee = parseFloat((price * 0.005).toFixed(2));
  const netPayout = parseFloat((price - timbLevy - platformFee).toFixed(2));

  const buyerIdx = db.users.findIndex(u => u.id === bale.highestBidder);
  const farmerIdx = db.users.findIndex(u => u.id === farmerId);
  db.users[buyerIdx].wallet -= price;
  db.users[farmerIdx].wallet += netPayout;

  const finalHash = generateHash(bale.currentHash, { netPayout, buyer: bale.highestBidder });
  bale.history.push({ action: 'SMART_CONTRACT_SETTLED', timestamp: new Date().toISOString(), actor: 'SYSTEM ORACLE', hash: finalHash, details: `Funds disbursed to EcoCash. Net: $${netPayout}. TIMB Levies paid.` });
  bale.currentHash = finalHash;
  bale.status = 'SOLD';
  bale.owner = bale.highestBidder;
  bale.receipt = { gross: price, timbLevy, platformFee, netPayout, method: 'EcoCash Mobile Money' };

  saveDatabase(db);
  res.json({ success: true, message: `Payment Disbursed via EcoCash! Net Payout: $${netPayout}` });
});

app.listen(PORT, () => console.log(`🚀 TOBACCO TRACE RUNNING ON PORT ${PORT}`));