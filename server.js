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
const JWT_SECRET = process.env.JWT_SECRET || 'tobacco-trace-super-secret-key-2025';
const JWT_EXPIRES_IN = '8h';

const defaultData = {
  ledger: {},
  users: [
    {
      id: 'G-12345',
      passwordHash: '$2a$10$Kw6Q1zIwTpJv9k6Xz5m4OuH9gC3rL8nM2pV7bN0yT4sQ1eW6uA5Yi',
      role: 'FARMER',
      name: 'Tinashe (Farmer)',
      wallet: 50,
      homeGPS: { lat: -17.8248, lon: 31.0530 }
    },
    {
      id: 'TIMB-001',
      passwordHash: '$2a$10$Lx7R2aJuUpKw0l7Ya6n5PvI0hD4sM9oN3qW8cO1zU5tR2fX7vB6Zj',
      role: 'ADMIN',
      name: 'TIMB Officer',
      wallet: 0
    },
    {
      id: 'BAT-001',
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
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function generateHash(previousHash, payload) {
  return crypto.createHash('sha256')
    .update(`${previousHash}-${JSON.stringify(payload)}-${Date.now()}`)
    .digest('hex');
}

// ─────────────────────────────────────────────
// PRICING ALGORITHM
// Base: weight × $3.00/kg
// Green Bonus: +$20.00 if woodScore ≤ 15
// ─────────────────────────────────────────────
function calculateFloorPrice(weight, woodScore) {
  const base = weight * 3.00;
  const greenBonus = woodScore <= 15 ? 20 : 0;
  return parseFloat((base + greenBonus).toFixed(2));
}

// ─────────────────────────────────────────────
// RISK ENGINE (extended)
// ─────────────────────────────────────────────
function assessRisk({ offlineMode, gps, user, weight, woodScore, woodWeight, inputs }) {
  let riskLevel = 'LOW';
  let riskReasons = [];
  let officerAssigned = 'None';

  // 1. Offline registration
  if (offlineMode) {
    riskLevel = 'MEDIUM';
    riskReasons.push('Offline Farmer — No Photo/GPS Evidence');
    officerAssigned = 'PENDING DISPATCH (Local Agritex)';
  }

  // 2. Geofencing
  if (!offlineMode && gps && user?.homeGPS) {
    const [lat, lon] = gps.split(',').map(Number);
    const dist = getDistance(lat, lon, user.homeGPS.lat, user.homeGPS.lon);
    if (dist > 5) {
      riskLevel = 'HIGH';
      riskReasons.push(`GEO-FRAUD: Registered ${dist.toFixed(2)}km from registered farm`);
      officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
    }
  }

  // 3. Yield impossibility
  if (woodScore > 0 && (weight / woodScore) > 20) {
    riskLevel = 'HIGH';
    riskReasons.push(`Yield Discrepancy: ${weight}kg impossible with Wood Score ${woodScore}`);
    officerAssigned = 'PENDING DISPATCH (TIMB Auditor)';
  }

  // 4. Deforestation hotspot
  if (gps?.includes('-16.8')) {
    riskLevel = 'HIGH';
    riskReasons.push('Geographic Hotspot: Karoi Zone 4 (Forestry Watch)');
    officerAssigned = 'PENDING DISPATCH (Forestry Commission)';
  }

  // 5. Wood weight anomaly — wood heavier than tobacco itself is suspicious
  if (woodWeight > 0 && woodWeight > weight * 1.5) {
    riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
    riskReasons.push(`Wood Weight Anomaly: ${woodWeight}kg wood declared for ${weight}kg tobacco`);
    if (officerAssigned === 'None') officerAssigned = 'PENDING REVIEW (Agritex)';
  }

  return {
    riskLevel,
    riskReason: riskReasons.length > 0 ? riskReasons.join(' | ') : 'Verified Origin — All Checks Passed',
    officerAssigned
  };
}

// ─────────────────────────────────────────────
// PUBLIC ROUTE — Login
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { growerId, nationalId } = req.body;
  const user = db.users.find(u => u.id === growerId);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid Credentials' });

  const isMatch = await bcrypt.compare(nationalId, user.passwordHash);
  if (!isMatch) return res.status(401).json({ success: false, error: 'Invalid Credentials' });

  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  const { passwordHash, ...safeUser } = user;
  res.json({ success: true, token, user: safeUser });
});

// ─────────────────────────────────────────────
// PROTECTED ROUTES
// ─────────────────────────────────────────────

// POST /api/bale — Enhanced Registration
app.post('/api/bale', verifyToken, (req, res) => {
  const {
    id,
    farmer,           // farmer ID (from session, validated below)
    variety,
    numberOfBales,    // NEW: how many bales in this batch
    weight,           // total batch weight (kg)
    estimatedValue,   // NEW: farmer's own estimated value ($)
    woodWeight,       // NEW: weight of wood used (kg)
    gps,
    curing,
    woodScore,
    inputs,           // NEW: [{ type: 'Fertilizer'|'Pesticide', name, amount, unit }]
    destination,      // NEW: auction floor / contractor
    destinationOther, // NEW: free-text if destination === 'Other'
    offlineMode,
    photoHash
  } = req.body;

  // Prevent impersonation — JWT id must match farmer field
  if (req.user.id !== farmer) return res.status(403).json({ error: 'Farmer ID mismatch with session token.' });
  if (db.ledger[id]) return res.status(400).json({ error: 'Bale ID already exists.' });

  const user = db.users.find(u => u.id === farmer);
  const parsedWeight = parseFloat(weight) || 0;
  const parsedWood = parseInt(woodScore) || 0;
  const parsedWoodWeight = parseFloat(woodWeight) || 0;
  const parsedBales = parseInt(numberOfBales) || 1;
  const parsedInputs = Array.isArray(inputs) ? inputs : [];
  const registrationDate = new Date().toISOString();
  const finalDestination = destination === 'Other' ? (destinationOther || 'Unspecified') : (destination || 'Unspecified');

  // Run engines
  const floorPrice = calculateFloorPrice(parsedWeight, parsedWood);
  const { riskLevel, riskReason, officerAssigned } = assessRisk({
    offlineMode, gps, user,
    weight: parsedWeight,
    woodScore: parsedWood,
    woodWeight: parsedWoodWeight,
    inputs: parsedInputs
  });

  const genesisHash = crypto.createHash('sha256')
    .update(`GENESIS-${id}-${farmer}-${registrationDate}`)
    .digest('hex');

  // Build chemical summary for audit trail
  const chemSummary = parsedInputs.length > 0
    ? parsedInputs.map(i => `${i.name} (${i.type}): ${i.amount}${i.unit}`).join(', ')
    : 'None declared';

  db.ledger[id] = {
    id,
    farmerId: farmer,
    farmerName: user?.name || farmer,
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
      details: `Origin: ${gps || 'Offline'} | Batch: ${parsedBales} bales @ ${parsedWeight}kg | Destination: ${finalDestination} | Inputs: ${chemSummary}`
    }]
  };

  saveDatabase(db);
  res.json({
    message: 'Bale Registered.',
    riskLevel,
    floorPrice,
    baleId: id
  });
});

app.get('/api/bales', verifyToken, (req, res) => {
  res.json(Object.values(db.ledger));
});

app.post('/api/bid', verifyToken, (req, res) => {
  const { baleId, buyerId, amount } = req.body;
  const bale = db.ledger[baleId];
  if (!bale || bale.status === 'SOLD') return res.status(400).json({ error: 'Unavailable' });
  if (amount < bale.floorPrice) return res.status(400).json({ error: `Bid rejected by Smart Contract. Floor price is $${bale.floorPrice}` });

  const buyer = db.users.find(u => u.id === buyerId);
  if (!buyer || buyer.wallet < amount) return res.status(400).json({ error: 'Insufficient Funds' });

  const newBidHash = generateHash(bale.currentHash, { amount, buyerId });
  bale.history.push({
    action: 'BID_PLACED',
    timestamp: new Date().toISOString(),
    actor: buyerId,
    hash: newBidHash,
    details: `Bid Amount: $${amount} | Buyer: ${buyerId}`
  });
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

  if (!bale || bale.farmerId !== farmerId || !bale.highestBid)
    return res.status(400).json({ error: 'Invalid operation' });
  if (bale.woodScore > 30) {
    bale.status = 'NON_COMPLIANT';
    saveDatabase(db);
    return res.status(400).json({ success: false, error: 'ENVIRONMENTAL COMPLIANCE FAILED.' });
  }
  if (bale.riskLevel === 'HIGH' && bale.officerAssigned.includes('PENDING'))
    return res.status(400).json({ success: false, error: 'LOCKED: Pending physical verification.' });

  const price = parseInt(bale.highestBid);
  const timbLevy = parseFloat((price * 0.015).toFixed(2));
  const platformFee = parseFloat((price * 0.005).toFixed(2));
  const netPayout = parseFloat((price - timbLevy - platformFee).toFixed(2));

  const buyerIdx = db.users.findIndex(u => u.id === bale.highestBidder);
  const farmerIdx = db.users.findIndex(u => u.id === farmerId);
  db.users[buyerIdx].wallet -= price;
  db.users[farmerIdx].wallet += netPayout;

  const finalHash = generateHash(bale.currentHash, { netPayout, buyer: bale.highestBidder });
  bale.history.push({
    action: 'SMART_CONTRACT_SETTLED',
    timestamp: new Date().toISOString(),
    actor: 'SYSTEM ORACLE',
    hash: finalHash,
    details: `Net: $${netPayout} disbursed via EcoCash | TIMB Levy: $${timbLevy} | Platform Fee: $${platformFee} | Destination: ${bale.destination}`
  });
  bale.currentHash = finalHash;
  bale.status = 'SOLD';
  bale.owner = bale.highestBidder;
  bale.receipt = { gross: price, timbLevy, platformFee, netPayout, method: 'EcoCash Mobile Money' };

  saveDatabase(db);
  res.json({ success: true, message: `Payment Disbursed via EcoCash! Net Payout: $${netPayout}` });
});

app.listen(PORT, () => console.log(`🚀 TOBACCO TRACE RUNNING ON PORT ${PORT}`));