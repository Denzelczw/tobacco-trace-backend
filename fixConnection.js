const fs = require('fs');
const path = require('path');

// The correct certificate we extracted from Docker
const cert = `-----BEGIN CERTIFICATE-----
MIIC1jCCAnygAwIBAgIUejqwqH65JyLEe5pldCMJspr3aMcwCgYIKoZIzj0EAwIw
cDELMAkGA1UEBhMCVVMxFzAVBgNVBAgTDk5vcnRoIENhcm9saW5hMQ8wDQYDVQQH
EwZEdXJoYW0xGTAXBgNVBAoTEG9yZzEuZXhhbXBsZS5jb20xHDAaBgNVBAMTE2Nh
Lm9yZzEuZXhhbXBsZS5jb20wHhcNMjYwMjAxMTQxNjAwWhcNMjcwMjAxMTQyMTAw
WjBbMQswCQYDVQQGEwJVUzEXMBUGA1UECBMOTm9ydGggQ2Fyb2xpbmExFDASBgNV
BAoTC0h5cGVybGVkZ2VyMQ0wCwYDVQQLEwRwZWVyMQ4wDAYDVQQDEwVwZWVyMDBZ
MBMGByqGSM49AgEGCCqGSM49AwEHA0IABNAHei0zcRVt3xXIPlxuRcgdsw/AFWgq
ArffKrALzIDERahu97ZS51QPTw2wgNJO9+7rGlkKNHytBR3fTgfaru+jggEHMIIB
AzAOBgNVHQ8BAf8EBAMCA6gwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMC
MAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYEFM5BRboLyEvoYwRlSxHVsS6tJsGHMB8G
A1UdIwQYMBaAFMx5EVSCqnDVXRhwq9UgbHoCNiKEMCwGA1UdEQQlMCOCFnBlZXIw
Lm9yZzEuZXhhbXBsZS5jb22CCWxvY2FsaG9zdDBWBggqAwQFBgcIAQRKeyJhdHRy
cyI6eyJoZi5BZmZpbGlhdGlvbiI6IiIsImhmLkVucm9sbG1lbnRJRCI6InBlZXIw
IiwiaGYuVHlwZSI6InBlZXIifX0wCgYIKoZIzj0EAwIDSAAwRQIhAIX4+uU8fvH4
FLluVAhxsU3WeAuA3tGgFMUkYJ0dppLmAiAHstqGW2wrMxaFcn0VZ9cbmziWMmQ9
mhhI7B/tUF6wag==
-----END CERTIFICATE-----`;

const connectionProfile = {
    "name": "test-network-org1",
    "version": "1.0.0",
    "client": {
        "organization": "Org1",
        "connection": {
            "timeout": {
                "peer": {
                    "endorser": "300"
                }
            }
        }
    },
    "organizations": {
        "Org1": {
            "mspid": "Org1MSP",
            "peers": [
                "peer0.org1.example.com"
            ],
            "certificateAuthorities": [
                "ca.org1.example.com"
            ]
        }
    },
    "peers": {
        "peer0.org1.example.com": {
            "url": "grpcs://peer0.org1.example.com:7051",
            "tlsCACerts": {
                "pem": cert
            },
            "grpcOptions": {
                "ssl-target-name-override": "peer0.org1.example.com",
                "hostnameOverride": "peer0.org1.example.com"
            }
        }
    },
    "certificateAuthorities": {
        "ca.org1.example.com": {
            "url": "https://localhost:7054",
            "caName": "ca-org1",
            "httpOptions": {
                "verify": false
            }
        }
    }
};

fs.writeFileSync(path.join(__dirname, 'connection.json'), JSON.stringify(connectionProfile, null, 4));
console.log("✅ connection.json has been repaired successfully!");
