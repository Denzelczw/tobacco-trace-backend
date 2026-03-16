'use strict';

const { Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const fs = require('fs');
const path = require('path');

async function main() {
    try {
        // 1. Load connection profile
        const ccpPath = path.resolve(__dirname, 'connection.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

        // 2. Connect to CA
        const caURL = ccp.certificateAuthorities['ca.org1.example.com'].url;
        const ca = new FabricCAServices(caURL, { verify: false });

        // 3. Get the Wallet
        const walletPath = path.join(process.cwd(), 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);

        // --- CHANGE: USING appUser3 ---
        const userId = 'appUser3'; 

        // 4. Check if user already exists
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            console.log(`An identity for the user "${userId}" already exists in the wallet`);
            return;
        }

        // 5. Check if admin exists
        const adminIdentity = await wallet.get('admin');
        if (!adminIdentity) {
            console.log('An identity for the admin user "admin" does not exist in the wallet');
            return;
        }

        // 6. Register & Enroll
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, 'admin');

        const secret = await ca.register({
            affiliation: 'org1.department1',
            enrollmentID: userId,
            role: 'client'
        }, adminUser);

        const enrollment = await ca.enroll({
            enrollmentID: userId,
            enrollmentSecret: secret
        });

        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        await wallet.put(userId, x509Identity);
        console.log(`Successfully registered and enrolled user "${userId}" and imported it into the wallet`);

    } catch (error) {
        console.error(`Failed to register user: ${error}`);
        process.exit(1);
    }
}

main();
