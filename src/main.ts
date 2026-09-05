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
import { Game, TAPS_TO_WIN } from "./game";
import hostAvatar from "../assets/player_host.png";
import guestAvatar from "../assets/player_guest.png";

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
// The host always starts on the left, the joiner always on the right —
// see the LANE_START_LEFT/RIGHT usage in updateTrack().
let isHost = true;

// ?dev=true jumps straight to the race screen with no peer connection, so
// the "You" climber can be driven locally to iterate on the race UI quickly.
const isDev = new URLSearchParams(location.search).get("dev") === "true";
let devMeProgress = 0;
let devOppProgress = 0;

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

/**
 * Surface the browser's own WebRTC connection state as plain-language
 * status, for the stretch after codes have been exchanged where the two
 * devices are actually finding each other and connecting.
 */
function watchConnectionState(
  peer: RTCPeerConnection,
  hint: HTMLElement,
): void {
  const describe = () => {
    switch (peer.connectionState) {
      case "connecting":
        hint.textContent = "Found them! Connecting…";
        break;
      case "connected":
        hint.textContent = "Connected! Starting the race…";
        break;
      case "failed":
      case "disconnected":
        hint.textContent = "Lost the connection. Go back and try again.";
        break;
    }
  };
  peer.onconnectionstatechange = describe;
  describe();
}

function goHome(): void {
  resetConnection();
  showScreen("screen-start");
}

/**
 * Mark a step in a "connect without scanning" list as not-yet-reachable
 * ("pending", dimmed and disabled), the thing to do right now ("current"),
 * or already handled ("done", dimmed but left interactive). This is what
 * makes it obvious what to do next regardless of how a player got there —
 * e.g. giving up on the camera partway through and switching to this flow
 * always lands on step 1 as "current", with the rest visibly not yet due.
 */
function setStepState(
  stepId: string,
  state: "pending" | "current" | "done",
): void {
  const step = $(stepId);
  step.classList.toggle("is-current", state === "current");
  step.classList.toggle("is-done", state === "done");
  step
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
    .forEach((el) => {
      el.disabled = state === "pending";
    });
}

// --- Host flow: create offer -> show QR -> scan answer -> connect ---

function resetHostManualSteps(): void {
  setStepState("host-step-1", "current");
  setStepState("host-step-2", "pending");
  setStepState("host-step-3", "pending");
  $("host-manual-hint").textContent = "";
  ($("host-answer-input") as HTMLInputElement).value = "";
}

async function startHostFlow(): Promise<void> {
  isHost = true;
  showScreen("screen-host-qr");
  const hint = $("host-qr-hint");
  const scanAnswerBtn = $("btn-host-scan-answer") as HTMLButtonElement;
  const troubleLink = $("host-trouble-link") as HTMLAnchorElement;
  scanAnswerBtn.hidden = true;
  troubleLink.hidden = true;
  resetHostManualSteps();
  hint.textContent = "Preparing connection…";

  pc = createPeerConnection();
  const { dc: channel, blob } = await createOfferBlob(pc);
  dc = channel;
  dc.onopen = () => onDataChannelOpen();

  await renderQr($("host-qr-canvas"), blob);
  hint.textContent = "Then tap below to scan their reply.";
  scanAnswerBtn.hidden = false;
  scanAnswerBtn.onclick = () => scanForAnswer();
  troubleLink.hidden = false;
  troubleLink.onclick = (ev) => {
    ev.preventDefault();
    resetHostManualSteps();
    showScreen("screen-host-manual");
  };

  const copyBtn = $("btn-host-copy-code") as HTMLButtonElement;
  const answerForm = $("host-answer-form") as HTMLFormElement;
  const answerInput = $("host-answer-input") as HTMLInputElement;
  const manualHint = $("host-manual-hint");

  copyBtn.onclick = () => {
    void copyToClipboard(encodeCode(blob));
    flashButtonLabel(copyBtn, "Copied!");
    setStepState("host-step-1", "done");
    setStepState("host-step-2", "done");
    setStepState("host-step-3", "current");
    answerInput.focus();
  };

  answerForm.onsubmit = (ev) => {
    ev.preventDefault();
    if (!pc) return;
    const decoded = decodeCode(answerInput.value);
    if (!decoded) {
      manualHint.textContent =
        "That code didn\u2019t look right. Check it and try again.";
      return;
    }
    manualHint.textContent = "Reading their code…";
    applyAnswerBlob(pc, decoded)
      .then(() => {
        if (pc) watchConnectionState(pc, manualHint);
      })
      .catch((err) => {
        manualHint.textContent =
          "That code didn\u2019t work. Check it and try again.";
        console.error(err);
      });
  };
}

async function scanForAnswer(): Promise<void> {
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan their reply code";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  ($("scan-trouble-link") as HTMLAnchorElement).hidden = true;
  hint.textContent = "Looking for a code…";

  activeScan = await startScanning(
    video,
    async (payload) => {
      if (!pc) return;
      hint.textContent = "Reading their code…";
      try {
        await applyAnswerBlob(pc, payload);
        // Connection completes async via dc.onopen -> onDataChannelOpen
        watchConnectionState(pc, hint);
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

/** Consume the host's offer, whichever way it arrived, and stash our reply. */
async function processOffer(
  payload: string,
  hint: HTMLElement,
): Promise<string> {
  pc = createPeerConnection();
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => onDataChannelOpen();
  };
  // ICE gathering (finding our own reachable network paths, via a STUN
  // server) is the one genuinely slow step here — worth calling out.
  pc.onicegatheringstatechange = () => {
    if (pc?.iceGatheringState === "gathering") {
      hint.textContent = "Finding your connection path…";
    }
  };
  const answerBlob = await createAnswerBlob(pc, payload);
  joinAnswerBlob = answerBlob;
  return answerBlob;
}

/** Camera-scan success path: process the offer, then show our reply as a QR. */
async function handleScannedOffer(
  payload: string,
  hint: HTMLElement,
): Promise<void> {
  hint.textContent = "Reading their code…";
  try {
    const answerBlob = await processOffer(payload, hint);
    showScreen("screen-join-qr");
    await renderQr($("join-qr-canvas"), answerBlob);
    if (pc) watchConnectionState(pc, $("join-qr-hint"));
  } catch (err) {
    console.error(err);
    hint.textContent = "That code didn\u2019t look right. Try again.";
  }
}

function resetJoinManualSteps(): void {
  setStepState("join-step-1", "current");
  setStepState("join-step-2", "pending");
  $("join-manual-hint").textContent = "";
  ($("join-offer-input") as HTMLInputElement).value = "";
}

async function startJoinFlow(): Promise<void> {
  isHost = false;
  showScreen("screen-scan");
  $("scan-title").textContent = "Scan the code on their screen";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  const troubleLink = $("scan-trouble-link") as HTMLAnchorElement;
  troubleLink.hidden = false;
  troubleLink.onclick = (ev) => {
    ev.preventDefault();
    resetJoinManualSteps();
    showScreen("screen-join-manual");
  };
  hint.textContent = "Looking for a code…";

  activeScan = await startScanning(
    video,
    (payload) => void handleScannedOffer(payload, hint),
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

// The host and joiner each render as a distinct character, consistently
// across both screens — not tied to "me" vs "them".
function setAvatarImages(): void {
  ($("avatar-me-dot") as HTMLImageElement).src = isHost
    ? hostAvatar
    : guestAvatar;
  ($("avatar-opp-dot") as HTMLImageElement).src = isHost
    ? guestAvatar
    : hostAvatar;
}

function startGame(): void {
  if (!dc) return;
  setAvatarImages();
  game = new Game(dc, {
    onProgress: (me, opp) => updateTrack(me, opp),
    onWin: (winner) => showResult(winner),
    onRematchRequested: () => startGame(),
  });
  showScreen("screen-race");
  updateTrack(0, 0);
  game.start();
}

// Both climbers start apart at the bottom corners and converge on the
// trophy at top-center as they climb. The host always starts bottom-left,
// the joiner always bottom-right — the same physical layout on both screens.
const LANE_START_LEFT = 22; // % from the left edge
const LANE_START_RIGHT = 78;
const LANE_CONVERGE = 50; // meets under the trophy
const ZIGZAG_AMPLITUDE = 7; // percentage points, at its widest mid-climb
const ZIGZAG_CYCLES = 2; // full wiggles along the climb

// A wiggle around the straight path to the trophy. The envelope fades it to
// exactly 0 at progress 0 and 1, so the start point and the convergence at
// the top are never thrown off by it.
function zigzagOffset(progress: number): number {
  const envelope = Math.sin(progress * Math.PI);
  return (
    ZIGZAG_AMPLITUDE *
    envelope *
    Math.sin(progress * ZIGZAG_CYCLES * Math.PI * 2)
  );
}

function positionAvatar(el: HTMLElement, progress: number, startX: number) {
  const track = el.parentElement as HTMLElement;
  const trackHeight = track.clientHeight - 28;
  const towardCenter = Math.sign(LANE_CONVERGE - startX) || 1;
  const baseX = startX + (LANE_CONVERGE - startX) * progress;
  const x = baseX + towardCenter * zigzagOffset(progress);
  el.style.left = `${x}%`;
  el.style.bottom = `${4 + progress * trackHeight}px`;
}

function updateTrack(me: number, opp: number): void {
  const meStartX = isHost ? LANE_START_LEFT : LANE_START_RIGHT;
  const oppStartX = isHost ? LANE_START_RIGHT : LANE_START_LEFT;
  positionAvatar($("avatar-me") as HTMLElement, me, meStartX);
  positionAvatar($("avatar-opp") as HTMLElement, opp, oppStartX);
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
// Each tap button twists "You" toward its own side, then springs back to
// center — left twists clockwise, right twists counter-clockwise.
function triggerTwist(direction: "cw" | "ccw"): void {
  const dot = $("avatar-me-dot");
  const twistClass = direction === "cw" ? "twist-cw" : "twist-ccw";
  dot.classList.remove("twist-cw", "twist-ccw");
  void dot.offsetWidth; // force reflow so a rapid re-tap restarts the animation
  dot.classList.add(twistClass);
}

function handleTap(direction: "cw" | "ccw"): void {
  triggerTwist(direction);
  if (game) {
    game.tap();
    return;
  }
  if (isDev) {
    devMeProgress = Math.min(1, devMeProgress + 1 / TAPS_TO_WIN);
    updateTrack(devMeProgress, devOppProgress);
  }
}
($("btn-tap-left") as HTMLButtonElement).onclick = () => handleTap("cw");
($("btn-tap-right") as HTMLButtonElement).onclick = () => handleTap("ccw");
const joinOfferForm = $("join-offer-form") as HTMLFormElement;
const joinOfferInput = $("join-offer-input") as HTMLInputElement;
const joinManualHint = $("join-manual-hint");
joinOfferForm.onsubmit = (ev) => {
  ev.preventDefault();
  const decoded = decodeCode(joinOfferInput.value);
  if (!decoded) {
    joinManualHint.textContent =
      "That code didn\u2019t look right. Check it and try again.";
    return;
  }
  joinManualHint.textContent = "Reading their code…";
  processOffer(decoded, joinManualHint)
    .then(() => {
      joinManualHint.textContent = "Waiting for them to connect…";
      if (pc) watchConnectionState(pc, joinManualHint);
      setStepState("join-step-1", "done");
      setStepState("join-step-2", "current");
    })
    .catch((err) => {
      console.error(err);
      joinManualHint.textContent =
        "That code didn\u2019t look right. Try again.";
    });
};

const joinCopyBtn = $("btn-join-copy-code") as HTMLButtonElement;
joinCopyBtn.onclick = () => {
  if (!joinAnswerBlob) return;
  void copyToClipboard(encodeCode(joinAnswerBlob));
  flashButtonLabel(joinCopyBtn, "Copied!");
};

document
  .querySelectorAll<HTMLAnchorElement>("[data-manual-back]")
  .forEach((link) => {
    link.onclick = (ev) => {
      ev.preventDefault();
      showScreen(
        link.dataset.manualBack === "host" ? "screen-host-qr" : "screen-scan",
      );
    };
  });
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

if (isDev) {
  setAvatarImages();
  showScreen("screen-race");
  updateTrack(devMeProgress, devOppProgress);
}
