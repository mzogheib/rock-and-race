// Minimal serverless WebRTC signaling helper.
//
// Because there's no signaling server, we can't "trickle" ICE candidates as
// they arrive. Instead we wait for ICE gathering to finish, then bundle the
// complete SDP (offer or answer) — including every discovered candidate —
// into one static JSON blob that gets shown as a QR code.
//
// A public STUN server is used to discover reachable candidates. This is a
// public service call from the browser, not a backend we run or host.

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    function check() {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Host side: create the data channel + offer, return it once ICE gathering completes. */
export async function createOfferBlob(
  pc: RTCPeerConnection,
): Promise<{ dc: RTCDataChannel; blob: string }> {
  const dc = pc.createDataChannel("game", { ordered: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  if (!pc.localDescription)
    throw new Error("Missing local description after gathering");
  return { dc, blob: JSON.stringify(pc.localDescription) };
}

/** Joiner side: consume the host's offer blob, return the answer blob once ICE gathering completes. */
export async function createAnswerBlob(
  pc: RTCPeerConnection,
  offerBlob: string,
): Promise<string> {
  const offer = JSON.parse(offerBlob) as RTCSessionDescriptionInit;
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  if (!pc.localDescription)
    throw new Error("Missing local description after gathering");
  return JSON.stringify(pc.localDescription);
}

/** Host side: consume the joiner's answer blob to complete the handshake. */
export async function applyAnswerBlob(
  pc: RTCPeerConnection,
  answerBlob: string,
): Promise<void> {
  const answer = JSON.parse(answerBlob) as RTCSessionDescriptionInit;
  await pc.setRemoteDescription(answer);
}
