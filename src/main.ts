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
  // The result screen is the only place it rains — leaving it should always
  // clear any drops still falling.
  if (id !== "screen-result") $("rain").replaceChildren();
}

const RAIN_DROP_COUNT = 28;

/** Rain a given emoji down over the whole screen — 🎉 for a win, 😭 for a loss. */
function rain(emoji: string): void {
  const container = $("rain");
  container.replaceChildren();
  for (let i = 0; i < RAIN_DROP_COUNT; i++) {
    const drop = document.createElement("span");
    drop.className = "rain-drop";
    drop.textContent = emoji;
    drop.style.left = `${Math.random() * 100}%`;
    drop.style.fontSize = `${18 + Math.random() * 20}px`;
    drop.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    drop.style.animationDelay = `${Math.random() * 1.2}s`;
    container.appendChild(drop);
  }
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
// ?dev=win / ?dev=lose jump straight to the result screen instead, with its
// rain, to iterate on that without playing out a whole race.
const devParam = new URLSearchParams(location.search).get("dev");
const isDev = devParam === "true";
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
 * Surface only a real problem with the browser's own WebRTC connection
 * state — not the routine "connecting…" progress, just when it's actually
 * failed or dropped, since that's the one case a player needs telling.
 */
function watchConnectionState(
  peer: RTCPeerConnection,
  hint: HTMLElement,
): void {
  const describe = () => {
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected"
    ) {
      hint.textContent = "Lost the connection. Go back and try again.";
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
      // Some inputs (e.g. the read-only code preview) must stay disabled no
      // matter the step's state — leave those alone.
      if (el.dataset.static !== undefined) return;
      // Most "done" controls (e.g. "Copy") stay usable in case you need to
      // repeat them. Ones marked disable-when-done aren't safe to redo once
      // submitted (re-processing a code would start a fresh connection), so
      // they lock along with "pending".
      const disableOnDone =
        state === "done" && el.dataset.disableWhenDone !== undefined;
      el.disabled = state === "pending" || disableOnDone;
    });
}

// --- Host flow: create offer -> show QR -> scan answer -> connect ---

function resetHostManualSteps(): void {
  setStepState("host-step-1", "current");
  setStepState("host-step-2", "pending");
  $("host-manual-hint").textContent = "";
  ($("host-answer-input") as HTMLInputElement).value = "";
}

/**
 * Jump straight to "paste their reply code" — for when the host is already
 * scanning for the reply (so their own invitation code is already shared)
 * but the camera isn't picking it up.
 */
function continueHostFallback(): void {
  setStepState("host-step-1", "done");
  setStepState("host-step-2", "current");
  $("host-manual-hint").textContent = "";
  showScreen("screen-host-manual");
}

async function startHostFlow(): Promise<void> {
  isHost = true;
  showScreen("screen-host-qr");
  const scanAnswerBtn = $("btn-host-scan-answer") as HTMLButtonElement;
  const troubleLink = $("host-trouble-link") as HTMLAnchorElement;
  scanAnswerBtn.hidden = true;
  troubleLink.hidden = true;
  resetHostManualSteps();
  setStepState("host-qr-step-1", "current");
  setStepState("host-qr-step-2", "pending");

  pc = createPeerConnection();
  const { dc: channel, blob } = await createOfferBlob(pc);
  dc = channel;
  dc.onopen = () => onDataChannelOpen();

  await renderQr($("host-qr-canvas"), blob);
  scanAnswerBtn.hidden = false;
  scanAnswerBtn.onclick = () => scanForAnswer();
  // Step 1 stays "current" rather than "done" — the QR needs to stay fully
  // visible the whole time, it's not a one-off action like "Copy" is.
  setStepState("host-qr-step-1", "current");
  setStepState("host-qr-step-2", "current");
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

  ($("host-code-preview") as HTMLInputElement).value = encodeCode(blob);

  copyBtn.onclick = () => {
    void copyToClipboard(encodeCode(blob));
    flashButtonLabel(copyBtn, "Copied!");
    setStepState("host-step-1", "done");
    setStepState("host-step-2", "current");
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
    manualHint.textContent = "";
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
  $("scan-step-1-text").textContent = "Scan your opponent's reply code";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  const troubleLink = $("scan-trouble-link") as HTMLAnchorElement;
  troubleLink.hidden = false;
  troubleLink.onclick = (ev) => {
    ev.preventDefault();
    continueHostFallback();
  };
  hint.textContent = "";

  activeScan = await startScanning(
    video,
    async (payload) => {
      if (!pc) return;
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
async function processOffer(payload: string): Promise<string> {
  pc = createPeerConnection();
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => onDataChannelOpen();
  };
  const answerBlob = await createAnswerBlob(pc, payload);
  joinAnswerBlob = answerBlob;
  // Whether this came from the camera or was typed in, show it in the
  // manual-fallback screen's step 1 too, so it's clear what was used.
  ($("join-offer-input") as HTMLInputElement).value = encodeCode(payload);
  return answerBlob;
}

/** Camera-scan success path: process the offer, then show our reply as a QR. */
async function handleScannedOffer(
  payload: string,
  hint: HTMLElement,
): Promise<void> {
  try {
    const answerBlob = await processOffer(payload);
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

// "Back to QR code" on the manual-connect screen returns to whichever
// screen the player fell back from — the camera, or the reply QR they'd
// already gotten to.
let joinManualBackTarget = "screen-scan";

/**
 * Jump straight to "send this reply code" — for when the player already
 * has a reply ready (they're looking at its QR) but the host can't scan it.
 */
function continueJoinFallback(): void {
  if (!joinAnswerBlob) return;
  joinManualBackTarget = "screen-join-qr";
  ($("join-code-preview") as HTMLInputElement).value =
    encodeCode(joinAnswerBlob);
  $("join-manual-hint").textContent = "";
  setStepState("join-step-1", "done");
  setStepState("join-step-2", "current");
  showScreen("screen-join-manual");
}

async function startJoinFlow(): Promise<void> {
  isHost = false;
  showScreen("screen-scan");
  $("scan-step-1-text").textContent = "Scan your opponent's invitation code";
  const video = $("scan-video") as HTMLVideoElement;
  const hint = $("scan-hint");
  const troubleLink = $("scan-trouble-link") as HTMLAnchorElement;
  troubleLink.hidden = false;
  troubleLink.onclick = (ev) => {
    ev.preventDefault();
    joinManualBackTarget = "screen-scan";
    resetJoinManualSteps();
    showScreen("screen-join-manual");
  };
  hint.textContent = "";

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
  // Reserve room for the avatar's own height (plus a little breathing room)
  // so it never climbs past the top edge of the track, however tall it is.
  const trackHeight = Math.max(0, track.clientHeight - el.offsetHeight - 8);
  const towardCenter = Math.sign(LANE_CONVERGE - startX) || 1;
  const baseX = startX + (LANE_CONVERGE - startX) * progress;
  const x = baseX + towardCenter * zigzagOffset(progress);
  el.style.left = `${x}%`;
  el.style.bottom = `${4 + progress * trackHeight}px`;
}

// We aren't told which button the opponent pressed, so their twist just
// alternates direction each tap — enough to read as "they're climbing too".
let lastOppProgress = 0;
let nextOppTwist: "cw" | "ccw" = "cw";

function updateTrack(me: number, opp: number): void {
  if (opp > lastOppProgress) {
    triggerTwist("avatar-opp-dot", nextOppTwist);
    nextOppTwist = nextOppTwist === "cw" ? "ccw" : "cw";
  }
  lastOppProgress = opp;

  const meStartX = isHost ? LANE_START_LEFT : LANE_START_RIGHT;
  const oppStartX = isHost ? LANE_START_RIGHT : LANE_START_LEFT;
  positionAvatar($("avatar-me") as HTMLElement, me, meStartX);
  positionAvatar($("avatar-opp") as HTMLElement, opp, oppStartX);
}

function showResult(winner: "me" | "opp"): void {
  $("result-headline").textContent = winner === "me" ? "You win!" : "You lose";
  showScreen("screen-result");
  rain(winner === "me" ? "🎉" : "😭");
}

// --- Wire up static buttons ---

($("btn-host") as HTMLButtonElement).onclick = () =>
  startHostFlow().catch(console.error);
($("btn-join") as HTMLButtonElement).onclick = () =>
  startJoinFlow().catch(console.error);
// Each tap button twists "You" toward its own side, then springs back to
// center — left twists counter-clockwise, right twists clockwise.
function triggerTwist(dotId: string, direction: "cw" | "ccw"): void {
  const dot = $(dotId);
  const twistClass = direction === "cw" ? "twist-cw" : "twist-ccw";
  dot.classList.remove("twist-cw", "twist-ccw");
  void dot.offsetWidth; // force reflow so a rapid re-tap restarts the animation
  dot.classList.add(twistClass);
}

function handleTap(direction: "cw" | "ccw"): void {
  triggerTwist("avatar-me-dot", direction);
  if (game) {
    game.tap();
    return;
  }
  if (isDev) {
    devMeProgress = Math.min(1, devMeProgress + 1 / TAPS_TO_WIN);
    updateTrack(devMeProgress, devOppProgress);
  }
}
($("btn-tap-left") as HTMLButtonElement).onclick = () => handleTap("ccw");
($("btn-tap-right") as HTMLButtonElement).onclick = () => handleTap("cw");
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
  joinManualHint.textContent = "";
  processOffer(decoded)
    .then((answerBlob) => {
      if (pc) watchConnectionState(pc, joinManualHint);
      ($("join-code-preview") as HTMLInputElement).value =
        encodeCode(answerBlob);
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

($("join-qr-trouble-link") as HTMLAnchorElement).onclick = (ev) => {
  ev.preventDefault();
  continueJoinFallback();
};

document
  .querySelectorAll<HTMLAnchorElement>("[data-manual-back]")
  .forEach((link) => {
    link.onclick = (ev) => {
      ev.preventDefault();
      showScreen(
        link.dataset.manualBack === "host"
          ? "screen-host-qr"
          : joinManualBackTarget,
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
} else if (devParam === "win" || devParam === "lose") {
  showResult(devParam === "win" ? "me" : "opp");
}
