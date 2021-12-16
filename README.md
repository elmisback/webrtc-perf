# Starting the host lookup server
See https://github.com/elmisback/auth-rtc. If you would prefer to use the public host lookup server, set the `SIGNALLING_HOSTNAME` environment variable to `auth-rtc.strcat.xyz:443`.

# Starting the signaling server
```bash
node host.js [--key <your_private_key>]
```

# Starting a peer
```bash
node client.js --host-key <signaling_server_key>.pub --id <peer_overlay_id>
```
Wait for the peer to finish connecting. This may take a moment or may fail if the signaling server is behind a NAT.

# Starting the control server
```bash
node control_server.js --host-key <signaling_server_key>.pub
```