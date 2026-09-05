import "./style.css";
import {
  createPeerConnection,
  createOfferBlob,
  createAnswerBlob,
  applyAnswerBlob,
} from "./webrtc";
import {
  renderQr,
  startScanning,
  encodeCode,
  decodeCode,
  type ScanHandle,
} from "./qr";
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
let joinAnswerBlob: string | null = null;

function resetConnection(): void {
  activeScan?.stop();
  activeScan = null;
  game?.stop();
  game = null;
  dc?.close();
  dc = null;
  pc?.close();
  pc = null;
  joinAnswerBlob = null;
}

/** Copy text to the clipboard, falling back to the old execCommand trick if needed. */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.error(err);
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch (err) {
    console.error(err);
  } finally {
    textarea.remove();
  }
}

/** Briefly swap a button's label to confirm an action, e.g. after a copy. */
function flashButtonLabel(
  btn: HTMLButtonElement,
  label: string,
  timeout = 1200,
): void {
  const original = btn.textContent;
  btn.textContent = label;
  window.setTimeout(() => {
    btn.textContent = original;
  }, timeout);
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
  const copyBtn = $("btn-host-copy-code") as HTMLButtonElement;
  const answerForm = $("host-answer-form") as HTMLFormElement;
  const answerInput = $("host-answer-input") as HTMLInputElement;
  scanAnswerBtn.hidden = true;
  answerForm.hidden = true;
  answerInput.value = "";
  hint.textContent = "Preparing connection…";

  pc = createPeerConnection();
  const { dc: channel, blob } = await createOfferBlob(pc);
  dc = channel;
  dc.onopen = () => onDataChannelOpen();

  await renderQr($("host-qr-canvas"), blob);
  hint.textContent = "Have them scan this, then tap below to scan their reply.";
  scanAnswerBtn.hidden = false;
  scanAnswerBtn.onclick = () => scanForAnswer();

  copyBtn.onclick = () => {
    void copyToClipboard(encodeCode(blob));
    flashButtonLabel(copyBtn, "Copied! Now send it to them.", 10000);
    answerForm.hidden = false;
    answerInput.focus();
  };

  answerForm.onsubmit = (ev) => {
    ev.preventDefault();
    if (!pc) return;
    const decoded = decodeCode(answerInput.value);
    if (!decoded) {
      hint.textContent =
        "That code didn\u2019t look right. Check it and try again.";
      return;
    }
    hint.textContent = "Connecting…";
    applyAnswerBlob(pc, decoded).catch((err) => {
      hint.textContent = "That code didn\u2019t work. Check it and try again.";
      console.error(err);
    });
  };
}

async function scanForAnswer(): Promise<void> {
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan their reply code";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  $("scan-fallback").hidden = true;
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

/** Consume the host's offer (however it arrived — scanned or pasted) and show our reply. */
async function handleOfferPayload(
  payload: string,
  hint: HTMLElement,
): Promise<void> {
  hint.textContent = "Generating your reply code…";
  pc = createPeerConnection();
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => onDataChannelOpen();
  };
  try {
    const answerBlob = await createAnswerBlob(pc, payload);
    joinAnswerBlob = answerBlob;
    showScreen("screen-join-qr");
    await renderQr($("join-qr-canvas"), answerBlob);
  } catch (err) {
    console.error(err);
    hint.textContent = "That code didn\u2019t look right. Try again.";
  }
}

async function startJoinFlow(): Promise<void> {
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan the code on their screen";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  const fallback = $("scan-fallback");
  const codeForm = $("scan-code-form") as HTMLFormElement;
  const codeInput = $("scan-code-input") as HTMLInputElement;
  fallback.hidden = false;
  codeInput.value = "";
  hint.textContent = "Looking for a code…";

  codeForm.onsubmit = (ev) => {
    ev.preventDefault();
    const decoded = decodeCode(codeInput.value);
    if (!decoded) {
      hint.textContent =
        "That code didn\u2019t look right. Check it and try again.";
      return;
    }
    activeScan?.stop();
    activeScan = null;
    void handleOfferPayload(decoded, hint);
  };

  activeScan = await startScanning(
    video,
    (payload) => void handleOfferPayload(payload, hint),
    (err) => {
      hint.textContent = "Camera access is needed to scan the code.";
      console.error(err);
    },
  );
}

// --- Shared: once the data channel is open on either side, start the race ---

function onDataChannelOpen(): void {
  startGame();
}

function startGame(): void {
  if (!dc) return;
  game = new Game(dc, {
    onProgress: (me, opp) => updateTrack(me, opp),
    onWin: (winner) => showResult(winner),
    onRematchRequested: () => startGame(),
  });
  showScreen("screen-race");
  updateTrack(0, 0);
  game.start();
}

function updateTrack(me: number, opp: number): void {
  const trackHeight =
    ($("avatar-me").parentElement as HTMLElement).clientHeight - 28;
  ($("avatar-me") as HTMLElement).style.bottom = `${4 + me * trackHeight}px`;
  ($("avatar-opp") as HTMLElement).style.bottom = `${4 + opp * trackHeight}px`;
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
($("btn-tap-left") as HTMLButtonElement).onclick = () => game?.tap();
($("btn-tap-right") as HTMLButtonElement).onclick = () => game?.tap();
const joinCopyBtn = $("btn-join-copy-code") as HTMLButtonElement;
joinCopyBtn.onclick = () => {
  if (!joinAnswerBlob) return;
  void copyToClipboard(encodeCode(joinAnswerBlob));
  flashButtonLabel(joinCopyBtn, "Copied!");
};
($("btn-rematch") as HTMLButtonElement).onclick = () => {
  if (dc && dc.readyState === "open") {
    game?.requestRematch();
    startGame();
  } else {
    goHome();
  }
};
document.querySelectorAll<HTMLElement>("[data-back]").forEach((btn) => {
  btn.onclick = () => goHome();
});
