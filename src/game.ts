const TAPS_TO_WIN = 40; // tune to taste
const BROADCAST_INTERVAL_MS = 80;

type ProgressMsg = { type: "progress"; value: number };

export type GameCallbacks = {
  onProgress: (me: number, opp: number) => void;
  onWin: (winner: "me" | "opp") => void;
};

export class Game {
  private myTaps = 0;
  private myProgress = 0;
  private oppProgress = 0;
  private finished = false;
  private broadcastTimer: number | undefined;

  constructor(
    private dc: RTCDataChannel,
    private callbacks: GameCallbacks,
  ) {
    this.dc.onmessage = (ev) => this.handleMessage(ev.data);
  }

  start(): void {
    this.myTaps = 0;
    this.myProgress = 0;
    this.oppProgress = 0;
    this.finished = false;
    this.broadcastTimer = window.setInterval(
      () => this.broadcastProgress(),
      BROADCAST_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.broadcastTimer !== undefined) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
  }

  tap(): void {
    if (this.finished) return;
    this.myTaps += 1;
    this.myProgress = Math.min(1, this.myTaps / TAPS_TO_WIN);
    this.callbacks.onProgress(this.myProgress, this.oppProgress);
    if (this.myProgress >= 1) {
      // Send the winning progress value before we stop broadcasting —
      // otherwise the opponent never receives the message that would tell
      // them the race is over.
      this.broadcastProgress();
      this.declareWin("me");
    }
  }

  private broadcastProgress(): void {
    if (this.dc.readyState !== "open") return;
    const msg: ProgressMsg = { type: "progress", value: this.myProgress };
    this.dc.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string): void {
    let msg: ProgressMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "progress") return;
    this.oppProgress = msg.value;
    this.callbacks.onProgress(this.myProgress, this.oppProgress);
    if (!this.finished && this.oppProgress >= 1) {
      this.declareWin("opp");
    }
  }

  private declareWin(winner: "me" | "opp"): void {
    this.finished = true;
    this.stop();
    this.callbacks.onWin(winner);
  }
}
