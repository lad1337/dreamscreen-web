// DreamScreen web + HomeKit control: npm i && node server.mjs  (DS_HOST, PORT, BIND, HOMEKIT, RETRIES env)
// Protocol (UDP 8888): FC len group flags cmdHi cmdLo payload… crc8(poly 7) over all prior bytes.
// len = payload + 5. Flags: 0x30 read, 0x11 write to one device, 0x60 state reply, 0x41 change notify.
// Replies always go to port 8888, so we must bind it.
import dgram from 'node:dgram';
import http from 'node:http';
import assert from 'node:assert';
import crypto from 'node:crypto';
import hap from 'hap-nodejs';

const DS_HOST = process.env.DS_HOST ?? '192.168.1.88';
const PORT = +(process.env.PORT ?? 8080);
const BIND = process.env.BIND ?? '127.0.0.1'; // 0.0.0.0 to reach it from a phone

const crc8 = b => { let c = 0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 7) & 0xff : (c << 1) & 0xff; } return c; };
const packet = (group, flags, hi, lo, p = []) => { const b = [0xfc, p.length + 5, group, flags, hi, lo, ...p]; return Buffer.from([...b, crc8(b)]); };
const valid = m => m.length >= 7 && m[0] === 0xfc && m[1] === m.length - 2 && crc8(m.subarray(0, -1)) === m.at(-1);
const str = b => b.toString('latin1').replace(/\0.*$/s, '').trim();

// Offsets in the 0x01 0x0A state reply payload, mapped on a DreamScreen 4K (product id = last byte, 2).
const parseState = p => ({
  name: str(p.subarray(0, 16)), group: str(p.subarray(16, 32)), groupNumber: p[32],
  mode: p[33], brightness: p[34], color: '#' + p.subarray(40, 43).toString('hex'),
  scene: p[62], hdmiInput: p[73],
  hdmiNames: [75, 91, 107].map(o => str(p.subarray(o, o + 16))), hdrToneRemapping: p[139], productId: p.at(-1),
});

// Writable settings: [cmdHi, cmdLo, payload encoder]. Values validated here (trust boundary).
const int = (lo, hi) => v => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw Error(`expected ${lo}-${hi}`); return [n]; };
const COMMANDS = {
  mode: [3, 0x01, int(0, 3)], // 0 sleep, 1 video, 2 music, 3 ambient
  brightness: [3, 0x02, int(0, 100)],
  color: [3, 0x05, v => { if (!/^#[0-9a-f]{6}$/i.test(v)) throw Error('expected #rrggbb'); return [...Buffer.from(v.slice(1), 'hex')]; }],
  ambientType: [3, 0x08, int(0, 1)], // 0 solid color, 1 scene (write-only, not in state reply)
  scene: [3, 0x0d, int(0, 8)],
  hdmiInput: [3, 0x20, int(0, 2)],
  hdrToneRemapping: [3, 0x60, int(0, 1)],
};
const SCENES = ['Random Color', 'Fireside', 'Twinkle', 'Ocean', 'Rainbow', 'July 4th', 'Holiday', 'Pop', 'Enchanted Forest'];

// HomeKit color is hue (0-360) + saturation (0-100); device brightness is global, so value is always full.
const hexToHs = hex => {
  const [r, g, b] = [...Buffer.from(hex.slice(1), 'hex')].map(x => x / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), max ? Math.round(d / max * 100) : 0];
};
const hsToHex = (h, s) => {
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - s / 100 * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return '#' + [f(5), f(3), f(1)].map(x => x.toString(16).padStart(2, '0')).join('');
};

if (process.argv[2] === 'check') {
  assert.equal(packet(0xff, 0x30, 1, 0x0a).toString('hex'), 'fc05ff30010a2a'); // accepted by the device
  assert.ok(valid(Buffer.from('fc060041030103f8', 'hex'))); // captured notify: mode=3
  assert.throws(() => COMMANDS.brightness[2](101));
  assert.deepEqual(COMMANDS.color[2]('#ffe6a1'), [255, 230, 161]);
  for (const c of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#ff8000']) assert.equal(hsToHex(...hexToHs(c)), c);
  console.log('ok'); process.exit();
}

const udp = dgram.createSocket('udp4'); // no reuseAddr: a second instance would silently steal the device's replies
let last = null, waiters = [];
udp.on('message', (m, r) => {
  if (r.address !== DS_HOST || !valid(m) || m[3] !== 0x60 || m[4] !== 1 || m[5] !== 0x0a) return;
  last = parseState(m.subarray(6, -1));
  waiters.splice(0).forEach(w => w(last));
  syncHomeKit(last);
});
const queryState = () => new Promise((resolve, reject) => {
  // ponytail: unicast query; broadcast queries were answered unreliably by this device
  waiters.push(resolve);
  udp.send(packet(0xff, 0x30, 1, 0x0a), 8888, DS_HOST);
  setTimeout(() => { waiters = waiters.filter(w => w !== resolve); reject(Error('no reply from ' + DS_HOST)); }, 1500);
});
// The device's Wi-Fi occasionally drops a packet (or an ARP lookup), so retry before giving up.
const RETRIES = +(process.env.RETRIES ?? 2);
const readState = async () => {
  for (let i = 0; ; i++) try { return await queryState(); } catch (e) { if (i >= RETRIES) throw e; }
};
let ambientType = null; // not in the state reply; only known after we set it
const apply = async (cmd, value) => {
  if (!Object.hasOwn(COMMANDS, cmd)) throw Error('unknown cmd');
  const [hi, lo, enc] = COMMANDS[cmd];
  udp.send(packet(last?.groupNumber ?? 0, 0x11, hi, lo, enc(value)), 8888, DS_HOST);
  if (cmd === 'ambientType') ambientType = value;
  await new Promise(r => setTimeout(r, 300)); // device needs a moment before state reflects the write
  return readState();
};

const server = http.createServer(async (req, res) => {
  const reply = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  try {
    if (req.method === 'GET' && req.url === '/') return reply(200, PAGE, 'text/html');
    if (req.method === 'GET' && req.url === '/api/state') return reply(200, await readState());
    if (req.method === 'POST' && req.url === '/api/set') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 1e4) throw Error('too large'); }
      const { cmd, value } = JSON.parse(body);
      return reply(200, await apply(cmd, value));
    }
    reply(404, { error: 'not found' });
  } catch (e) { reply(e.message.startsWith('no reply') ? 504 : 400, { error: e.message }); }
});

// --- HomeKit: one Television accessory (power + HDMI inputs) with the other settings as extra services.
const { Accessory, Service, Characteristic: C, uuid, Categories, HAPStorage } = hap;
HAPStorage.setCustomStoragePath(new URL('./persist', import.meta.url).pathname); // pairings live here
const acc = new Accessory('DreamScreen', uuid.generate('dreamscreen:' + DS_HOST));
const add = (type, name, subtype) => {
  const s = acc.addService(type, name, subtype);
  if (!s.testCharacteristic(C.ConfiguredName)) s.addOptionalCharacteristic(C.ConfiguredName); // Home shows this name
  return s.setCharacteristic(C.ConfiguredName, name);
};
const onSet = (svc, ch, fn) => svc.getCharacteristic(ch).onSet(async v => { await fn(v); });
const offIf = active => active && apply('mode', 0); // turning off the active mode/scene puts the device to sleep

// HOMEKIT=power,hdr exposes only those; HOMEKIT= (empty) disables HomeKit. Default: everything.
const FUNCTIONS = ['power', 'inputs', 'ambient', 'modes', 'scenes', 'hdr'];
const exposed = (process.env.HOMEKIT ?? FUNCTIONS.join()).split(',').map(f => f.trim()).filter(Boolean);
const unknownFns = exposed.filter(f => !FUNCTIONS.includes(f));
if (unknownFns.length) throw Error(`HOMEKIT: unknown ${unknownFns} (choose from ${FUNCTIONS})`);
const has = f => exposed.includes(f);
const power = v => v ? last?.mode === 0 && apply('mode', 1) : apply('mode', 0); // on wakes into video mode

const powerSwitch = has('power') ? add(Service.Switch, 'DreamScreen', 'power') : null;
if (powerSwitch) onSet(powerSwitch, C.On, power);
const tv = has('inputs') ? add(Service.Television, 'DreamScreen').setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE) : null;
if (tv) {
  onSet(tv, C.Active, power);
  onSet(tv, C.ActiveIdentifier, v => apply('hdmiInput', v - 1));
  onSet(tv, C.RemoteKey, () => {}); // Home's remote expects the handler; the device has nothing to map it to
}
const inputs = !tv ? [] : [1, 2, 3].map(i => {
  const s = add(Service.InputSource, 'HDMI ' + i, 'hdmi' + i).setCharacteristic(C.Identifier, i)
    .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED).setCharacteristic(C.InputSourceType, C.InputSourceType.HDMI)
    .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
  tv.addLinkedService(s);
  return s;
});

const light = has('ambient') ? add(Service.Lightbulb, 'Ambient Light', 'ambient') : null;
// Home sends hue and saturation as two separate writes; batch them into one color change.
const hs = {};
const setHs = k => v => {
  hs[k] = v; clearTimeout(hs.timer);
  hs.timer = setTimeout(async () => {
    const [h, s] = hexToHs(last?.color ?? '#ffffff'), color = hsToHex(hs.h ?? h, hs.s ?? s);
    delete hs.h; delete hs.s;
    await apply('ambientType', 0); await apply('color', color); await apply('mode', 3);
  }, 100);
};
if (light) {
  onSet(light, C.On, v => v ? apply('mode', 3) : offIf(last?.mode === 3));
  onSet(light, C.Brightness, v => apply('brightness', v));
  onSet(light, C.Hue, setHs('h'));
  onSet(light, C.Saturation, setHs('s'));
}

const modeSwitches = !has('modes') ? [] : [[1, 'Video'], [2, 'Music']].map(([mode, name]) => {
  const s = add(Service.Switch, name + ' Mode', 'mode' + mode);
  onSet(s, C.On, v => v ? apply('mode', mode) : offIf(last?.mode === mode));
  return [mode, s];
});
const sceneActive = i => last?.mode === 3 && ambientType === 1 && last.scene === i;
const sceneSwitches = !has('scenes') ? [] : SCENES.map((name, i) => {
  const s = add(Service.Switch, name, 'scene' + i);
  onSet(s, C.On, async v => { if (!v) return offIf(sceneActive(i)); await apply('ambientType', 1); await apply('scene', i); await apply('mode', 3); });
  return s;
});
const hdr = has('hdr') ? add(Service.Switch, 'HDR Tone Mapping', 'hdr') : null;
if (hdr) onSet(hdr, C.On, v => apply('hdrToneRemapping', v ? 1 : 0));

function syncHomeKit(s) {
  powerSwitch?.updateCharacteristic(C.On, s.mode !== 0);
  tv?.updateCharacteristic(C.Active, s.mode ? 1 : 0).updateCharacteristic(C.ActiveIdentifier, s.hdmiInput + 1);
  inputs.forEach((x, i) => s.hdmiNames[i] && x.updateCharacteristic(C.ConfiguredName, s.hdmiNames[i]));
  if (light) {
    const [h, sat] = hexToHs(s.color);
    light.updateCharacteristic(C.On, s.mode === 3).updateCharacteristic(C.Brightness, s.brightness)
      .updateCharacteristic(C.Hue, h).updateCharacteristic(C.Saturation, sat);
  }
  modeSwitches.forEach(([mode, x]) => x.updateCharacteristic(C.On, s.mode === mode));
  sceneSwitches.forEach((x, i) => x.updateCharacteristic(C.On, sceneActive(i)));
  hdr?.updateCharacteristic(C.On, !!s.hdrToneRemapping);
}

// Stable HomeKit id per device so pairings survive restarts; fresh PIN each start (only needed to pair).
const username = crypto.createHash('sha1').update(DS_HOST).digest().subarray(0, 6).toString('hex').match(/../g).join(':').toUpperCase();
const pin = String(crypto.randomInt(1e8)).padStart(8, '0').replace(/(\d{3})(\d{2})(\d{3})/, '$1-$2-$3');

udp.bind(8888, () => server.listen(PORT, BIND, async () => {
  console.log(`http://${BIND}:${PORT}  ->  DreamScreen ${DS_HOST}`);
  if (exposed.length) {
    await acc.publish({ username, pincode: pin, category: tv ? Categories.TELEVISION : Categories.SWITCH });
    console.log(`HomeKit (${exposed}): add "DreamScreen" in the Home app with code ${pin}`);
  }
  // ponytail: 10s poll keeps Home in sync with changes made elsewhere; lower it if that feels laggy
  const poll = () => readState().catch(e => console.warn(e.message));
  poll(); setInterval(poll, 10000);
}));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DreamScreen</title><style>
:root{color-scheme:light dark;font-family:system-ui;--accent:#6b5cff}
body{max-width:420px;margin:0 auto;padding:16px;background:Canvas;color:CanvasText}
h1{font-size:1.3rem;margin:0}small{opacity:.6}
fieldset{border:1px solid #8884;border-radius:10px;margin:14px 0;padding:10px 12px}legend{opacity:.7;font-size:.85rem}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
button{padding:10px 0;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=range],select{width:100%}input[type=color]{width:100%;height:44px;border:0;background:none}
#err{color:#e55;min-height:1.2em}
</style></head><body>
<h1 id="name">DreamScreen</h1><small id="info">connecting…</small>
<fieldset><legend>Mode</legend><div class="row" id="modes"></div></fieldset>
<fieldset><legend>Brightness <span id="bv"></span>%</legend><input type="range" id="brightness" min="0" max="100"></fieldset>
<fieldset><legend>Ambient</legend>
 <label>Color <input type="color" id="color"></label>
 <label>Scene <select id="scene"></select></label></fieldset>
<fieldset><legend>Input</legend><div class="row" id="inputs" style="grid-template-columns:repeat(3,1fr)"></div></fieldset>
<fieldset><legend>HDR tone mapping</legend><div class="row" id="hdr" style="grid-template-columns:repeat(2,1fr)"></div></fieldset>
<div id="err" role="alert"></div>
<script>
const $ = id => document.getElementById(id);
const MODES = ['Sleep', 'Video', 'Music', 'Ambient'];
const SCENES = ['Random Color', 'Fireside', 'Twinkle', 'Ocean', 'Rainbow', 'July 4th', 'Holiday', 'Pop', 'Enchanted Forest'];
const btn = (parent, label, onclick) => { const b = document.createElement('button'); b.textContent = label; b.onclick = onclick; parent.append(b); return b; };
const modeBtns = MODES.map((m, i) => btn($('modes'), m, () => set('mode', i)));
const inputBtns = [0, 1, 2].map(i => btn($('inputs'), 'HDMI ' + (i + 1), () => set('hdmiInput', i)));
SCENES.forEach((s, i) => $('scene').add(new Option(s, i)));
const hdrBtns = ['Off', 'On'].map((l, i) => btn($('hdr'), l, () => set('hdrToneRemapping', i)));
function render(s) {
  if (s.error) return $('err').textContent = s.error;
  $('err').textContent = '';
  $('name').textContent = s.name; $('info').textContent = 'group: ' + s.group;
  modeBtns.forEach((b, i) => b.setAttribute('aria-pressed', i === s.mode));
  hdrBtns.forEach((b, i) => b.setAttribute('aria-pressed', i === s.hdrToneRemapping));
  inputBtns.forEach((b, i) => { b.setAttribute('aria-pressed', i === s.hdmiInput); b.textContent = s.hdmiNames[i] || 'HDMI ' + (i + 1); });
  if (document.activeElement !== $('brightness')) $('brightness').value = s.brightness;
  $('bv').textContent = s.brightness; $('color').value = s.color; $('scene').value = s.scene;
}
const call = (url, opts) => fetch(url, opts).then(r => r.json()).then(render).catch(e => render({ error: e.message }));
const set = (cmd, value) => call('/api/set', { method: 'POST', body: JSON.stringify({ cmd, value }) });
$('brightness').oninput = e => $('bv').textContent = e.target.value;
$('brightness').onchange = e => set('brightness', +e.target.value);
$('color').onchange = async e => { await set('ambientType', 0); set('color', e.target.value); };
$('scene').onchange = async e => { await set('ambientType', 1); set('scene', +e.target.value); };
call('/api/state'); setInterval(() => document.hidden || call('/api/state'), 5000);
</script></body></html>`;
