# dreamscreen-web

Web UI and HomeKit accessory for a [DreamScreen 4K](https://www.dreamscreentv.com/), talking to it directly over its local UDP protocol. No cloud, one file (`server.mjs`), one dependency ([hap-nodejs](https://github.com/homebridge/HAP-NodeJS)).

The web UI controls mode (sleep, video, music, ambient), brightness, ambient color and scene, HDMI input, and HDR tone mapping.

## Requirements

- Node.js 24 (hap-nodejs supports up to 24), or Docker
- Same network as the DreamScreen. The device always replies to UDP port **8888**, so that port must be free on the host.

## Run locally

```sh
npm ci
DS_HOST=192.168.1.88 node server.mjs
```

Open http://127.0.0.1:8080. Use `BIND=0.0.0.0` to reach it from other devices (no authentication).

`node server.mjs check` runs the built-in self-test.

## Configuration

| Variable  | Default        | Description |
|-----------|----------------|-------------|
| `DS_HOST` | `192.168.1.88` | IP address of the DreamScreen |
| `PORT`    | `8080`         | Web UI port |
| `BIND`    | `127.0.0.1`    | Web UI listen address (`0.0.0.0` in Docker) |
| `HOMEKIT` | all            | Comma-separated HomeKit functions: `power`, `inputs`, `ambient`, `modes`, `scenes`, `hdr`. Empty disables HomeKit. |
| `RETRIES` | `2`            | Extra attempts when the device doesn't answer a state query (1.5 s each) |

## HomeKit

On start the server prints a pairing code:

```
HomeKit (power,hdr): add "DreamScreen" in the Home app with code 123-45-678
```

In the Home app, choose **Add Accessory → More options → DreamScreen** and enter the code. The code changes on every start but is only needed for pairing. Pairings are stored in `persist/`; keep that folder (or the Docker volume) to stay paired.

| Function  | Shows up as |
|-----------|-------------|
| `power`   | Switch "DreamScreen": off = sleep, on = video mode |
| `inputs`  | TV tile with power and the HDMI inputs |
| `ambient` | Light "Ambient Light": ambient mode, brightness, color |
| `modes`   | Switches "Video Mode", "Music Mode" |
| `scenes`  | One switch per ambient scene |
| `hdr`     | Switch "HDR Tone Mapping" |

If you change from or to `inputs` after pairing, the accessory type changes (TV vs. switch): remove it from Home and pair again.

## Docker

Host networking is required: the device replies to UDP 8888 and HomeKit uses mDNS.

```sh
docker build -t dreamscreen-web .
docker run -d --name dreamscreen-web --restart unless-stopped --network host \
  -e PORT=8099 -e DS_HOST=192.168.1.88 -e HOMEKIT=power,hdr \
  -v /path/to/persist:/app/persist dreamscreen-web
```

The pairing code is in `docker logs dreamscreen-web`.

## Unraid

```sh
git clone https://github.com/lad1337/dreamscreen-web.git /mnt/user/Apps/workspace/dreamscreen-web
cd /mnt/user/Apps/workspace/dreamscreen-web
docker build -t dreamscreen-web .
cp unraid-template.xml /boot/config/plugins/dockerMan/templates-user/my-dreamscreen-web.xml
```

Then in the **Docker** tab: **Add Container**, pick the `dreamscreen-web` template, adjust the settings and click **Apply**. The template runs as `99:100` (nobody:users), stores pairings in `/mnt/user/Apps/dreamscreen-web` and serves the web UI on port 8099.

To update: `git pull && docker build -t dreamscreen-web .` in the checkout, then **Apply** on the container. The image is built locally, so Unraid's update check shows it as "not available"; that's expected.

## Protocol

Reverse-engineered on a DreamScreen 4K. Everything is UDP on port 8888, and replies always go to port 8888 on the sender.

```
FC  len  group  flags  cmdHi  cmdLo  payload…  crc
```

- `len` = payload length + 5
- `crc` = CRC-8 (polynomial 0x07, initial 0) over all preceding bytes
- flags: `0x30` read, `0x11` write to one device, `0x60` state reply, `0x41` change notification (broadcast by the device after every write)

Query state by sending `01 0A` with flags `0x30` directly to the device; broadcast queries were answered unreliably. The 141-byte reply payload:

| Offset  | Field |
|---------|-------|
| 0–15    | Device name |
| 16–31   | Group name |
| 32      | Group number |
| 33      | Mode (0 sleep, 1 video, 2 music, 3 ambient) |
| 34      | Brightness (0–100) |
| 40–42   | Ambient color RGB |
| 62      | Ambient scene |
| 73      | HDMI input (0–2) |
| 75, 91, 107 | HDMI input names (16 bytes each) |
| 139     | HDR tone mapping (0/1) |
| 140     | Product ID (2 = 4K) |

Write commands (flags `0x11`, group from byte 32):

| Command | Payload |
|---------|---------|
| `03 01` mode | 1 byte, 0–3 |
| `03 02` brightness | 1 byte, 0–100 |
| `03 05` ambient color | 3 bytes RGB |
| `03 08` ambient type | 0 color, 1 scene (not reported in the state reply) |
| `03 0D` ambient scene | 1 byte, 0–8 |
| `03 20` HDMI input | 1 byte, 0–2 |
| `03 60` HDR tone mapping | 0/1 |

The device may refuse to switch to an HDMI input without a signal.
