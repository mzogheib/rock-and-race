# Tap Race

A two-player, fully client-side tap-to-race game. No backend at all — two
phones connect directly over WebRTC, exchanging the connection handshake as
QR codes scanned in-page.

## How the connection works

1. **Host** clicks "Start a race" → creates an `RTCPeerConnection` + a
   WebRTC data channel, generates an SDP offer, waits for ICE gathering to
   finish, then shows the whole thing as a QR code.
2. **Joiner** scans it (camera feed rendered in-page via `jsQR`, no native
   camera app involved), generates an SDP answer, waits for its own ICE
   gathering, and shows _that_ as a second QR code.
3. **Host** scans the joiner's code back. The data channel opens on both
   sides → the race begins.

Only a public STUN server (Google's) is used to help discover reachable
network addresses — that's a public service call from the browser, not a
backend this app runs. There's no TURN relay, so this works reliably when
both phones are on the same network (the expected case: two people standing
next to each other), but may fail across strict/separate NATs.

Gameplay itself (tap progress) streams directly over the WebRTC data channel
once connected — no signaling server involved at any point after the QR
handshake.

## Project structure

```
index.html        - all app screens (start/host/scan/race/result), toggled via JS
src/main.ts       - app state machine, wires everything together
src/webrtc.ts     - offer/answer creation, ICE-gathering wait
src/qr.ts         - QR generation (canvas) + in-page camera scanning
src/game.ts       - tap counting, progress broadcast, win detection
src/style.css     - visual design
```

## Local development

```
npm install
npm run dev
```

Note: camera access (`getUserMedia`) requires HTTPS or `localhost`. Vite's
dev server serves over `http://localhost`, which counts as a secure context,
so scanning works locally. To test with two real phones during development,
use a tunnel (e.g. `ngrok http 5173`) so both devices get an HTTPS URL.

## Deploying to GitHub Pages

```
npm run build
```

This produces static files in `dist/`. To publish:

1. Push `dist/`'s contents to a `gh-pages` branch (or use the
   `peaceiris/actions-gh-pages` GitHub Action to do this automatically on
   push to `main`).
2. In your repo settings → Pages, set the source to the `gh-pages` branch.
3. `vite.config.ts` already sets `base: './'` (relative paths), so this
   works whether you're hosting at a root domain or a
   `https://<user>.github.io/<repo>/` project path — no config changes
   needed either way.

## Tuning the race

`TAPS_TO_WIN` in `src/game.ts` controls how many taps it takes to reach the
finish line. `BROADCAST_INTERVAL_MS` controls how often progress updates are
sent over the data channel (lower = smoother opponent movement, more
messages).
