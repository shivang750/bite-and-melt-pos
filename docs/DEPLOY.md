# Deploying the server

Any machine with Node.js ≥ 22.5 works (VPS, Raspberry Pi, a cloud VM). Use **HTTPS** and keep the `data/` folder on a persistent disk.

```bash
git/scp the folder to the server
cd bite-and-melt-pos
export BM_ADMIN_PASSWORD='ChooseAStrongOne1' PORT=3000 DATA_DIR=/var/lib/bitemelt
node --no-warnings server/server.js
```

## Keep it running (Linux systemd)
```ini
# /etc/systemd/system/bitemelt.service
[Service] 
WorkingDirectory=/opt/bite-and-melt-pos
Environment=PORT=3000 DATA_DIR=/var/lib/bitemelt BM_ADMIN_PASSWORD=ChooseAStrongOne1
ExecStart=/usr/bin/node --no-warnings server/server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
`systemctl enable --now bitemelt`

## HTTPS
Put Caddy or nginx in front (Caddy: `pos.yourcafe.in { reverse_proxy localhost:3000 }` gets a free certificate automatically). The server sets Secure cookies when it sees `X-Forwarded-Proto: https`. HTTPS is required for installing as a PWA and for the offline cache.

## First steps after deployment
Log in → change the admin password → Settings: cafe name, address, phone, logo, **UPI ID** → Menu: replace sample items/prices ("Delete all items" is available in Menu) → create staff users for counter staff (they can bill but not edit menu/prices or export).
Set the cafe's real UPI ID before taking payments and scan one test QR with your own phone.
