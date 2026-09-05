import "./style.css";
import {
  createPeerConnection,
  createOfferBlob,
  createAnswerBlob,
  applyAnswerBlob,
} from "./webrtc";
import { renderQr, startScanning, type ScanHandle } from "./qr";
import { Game } from "./game";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function showScreen(id: string): void {
  document
    .querySelectorAll<HTMLElement>(".screen")
    .forEach((el) => el.classList.remove("active"));
  $(id).classList.add("active");
}

let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let game: Game | null = null;
let activeScan: ScanHandle | null = null;

function resetConnection(): void {
  activeScan?.stop();
  activeScan = null;
  game?.stop();
  game = null;
  dc?.close();
  dc = null;
  pc?.close();
  pc = null;
}

function goHome(): void {
  resetConnection();
  showScreen("screen-start");
}

// --- Host flow: create offer -> show QR -> scan answer -> connect ---

async function startHostFlow(): Promise<void> {
  showScreen("screen-host-qr");
  const hint = $("host-qr-hint");
  const scanAnswerBtn = $("btn-host-scan-answer") as HTMLButtonElement;
  scanAnswerBtn.hidden = true;
  hint.textContent = "Preparing connection…";

  pc = createPeerConnection();
  const { dc: channel, blob } = await createOfferBlob(pc);
  dc = channel;
  dc.onopen = () => onDataChannelOpen();

  await renderQr($("host-qr-canvas"), blob);
  hint.textContent = "Have them scan this, then tap below to scan their reply.";
  scanAnswerBtn.hidden = false;
  scanAnswerBtn.onclick = () => scanForAnswer();
}

async function scanForAnswer(): Promise<void> {
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan their reply code";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  hint.textContent = "Looking for a code…";

  activeScan = await startScanning(
    video,
    async (payload) => {
      if (!pc) return;
      hint.textContent = "Connecting…";
      try {
        await applyAnswerBlob(pc, payload);
        // Connection completes async via dc.onopen -> onDataChannelOpen
      } catch (err) {
        hint.textContent = "That code didn\u2019t work. Try scanning again.";
        console.error(err);
        void scanForAnswer();
      }
    },
    (err) => {
      hint.textContent = "Camera access is needed to scan the code.";
      console.error(err);
    },
  );
}

// --- Joiner flow: scan offer -> create answer -> show QR -> wait for connect ---

async function startJoinFlow(): Promise<void> {
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan the code on their screen";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  hint.textContent = "Looking for a code…";

  activeScan = await startScanning(
    video,
    async (payload) => {
      hint.textContent = "Generating your reply code…";
      pc = createPeerConnection();
      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        dc.onopen = () => onDataChannelOpen();
      };
      try {
        const answerBlob = await createAnswerBlob(pc, payload);
        showScreen("screen-join-qr");
        await renderQr($("join-qr-canvas"), answerBlob);
      } catch (err) {
        console.error(err);
        hint.textContent = "That code didn\u2019t look right. Try again.";
      }
    },
    (err) => {
      hint.textContent = "Camera access is needed to scan the code.";
      console.error(err);
    },
  );
}

// --- Shared: once the data channel is open on either side, start the race ---

function onDataChannelOpen(): void {
  if (!dc) return;
  game = new Game(dc, {
    onProgress: (me, opp) => updateTrack(me, opp),
    onWin: (winner) => showResult(winner),
  });
  showScreen("screen-race");
  updateTrack(0, 0);
  game.start();
}

function updateTrack(me: number, opp: number): void {
  const trackWidth =
    ($("avatar-me").parentElement as HTMLElement).clientWidth - 28;
  ($("avatar-me") as HTMLElement).style.left = `${4 + me * trackWidth}px`;
  ($("avatar-opp") as HTMLElement).style.left = `${4 + opp * trackWidth}px`;
}

function showResult(winner: "me" | "opp"): void {
  $("result-headline").textContent = winner === "me" ? "You win" : "You lose";
  showScreen("screen-result");
}

// --- Wire up static buttons ---

($("btn-host") as HTMLButtonElement).onclick = () =>
  startHostFlow().catch(console.error);
($("btn-join") as HTMLButtonElement).onclick = () =>
  startJoinFlow().catch(console.error);
($("btn-tap") as HTMLButtonElement).onclick = () => game?.tap();
($("btn-rematch") as HTMLButtonElement).onclick = () => {
  if (dc && dc.readyState === "open") {
    game = new Game(dc, {
      onProgress: (me, opp) => updateTrack(me, opp),
      onWin: (winner) => showResult(winner),
    });
    showScreen("screen-race");
    updateTrack(0, 0);
    game.start();
  } else {
    goHome();
  }
};
document.querySelectorAll<HTMLElement>("[data-back]").forEach((btn) => {
  btn.onclick = () => goHome();
});
