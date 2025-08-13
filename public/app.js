const els = (sel) => document.querySelector(sel);
const $status = els("#status");
const $btnCreate = els("#btnCreate");
const $btnJoin = els("#btnJoin");
const $btnScan = els("#btnScan");
const $codeInput = els("#codeInput");
const $qrArea = els("#qrArea");
const $qrImg = els("#qrImg");
const $displayCode = els("#displayCode");
const $scanArea = els("#scanArea");
const $transfer = els("#transfer");
const $fileInput = els("#fileInput");
const $sendBtn = els("#sendBtn");
const $sendProg = els("#sendProg");
const $recvProg = els("#recvProg");
const $downloadLink = els("#downloadLink");

const api = (path, opts={}) => fetch(path, { headers: { "Content-Type": "application/json" }, ...opts }).then(r=>r.json());

let sessionId = null;
let ws = null;
let pc = null;
let dc = null;
let isSender = false;
const MAX_CHUNK = 16 * 1024; // 16 KB chunks for DataChannel
let recvBuffer = [];
let recvSize = 0;
let expectedSize = 0;
let filename = "file.bin";
let mime = "application/octet-stream";

// Parse code from URL (?code=1234)
const urlParams = new URLSearchParams(location.search);
const codeFromUrl = urlParams.get("code");
if (codeFromUrl) {
  $codeInput.value = codeFromUrl;
}

function logStatus(msg) {
  $status.textContent = msg;
  console.log("[status]", msg);
}

function showQR(code, dataUrl) {
  $qrArea.classList.remove("hidden");
  $displayCode.textContent = code.split("").join(" ");
  $qrImg.src = dataUrl;
}

async function createSession() {
  const res = await api("/api/session", { method: "POST", body: JSON.stringify({ action: "create" }) });
  if (!res.ok) { logStatus(res.error || "Failed to create"); return; }
  sessionId = res.sessionId;
  showQR(res.code, res.qrDataURL);
  logStatus(`Session created. Code ${res.code} (expires in ${res.expiresInSec/60|0} min)`);
  isSender = true;
  initWS();
}

async function resolveCode(code) {
  const res = await api("/api/resolve", { method: "POST", body: JSON.stringify({ code }) });
  if (!res.ok) { logStatus(res.error || "Invalid code"); return null; }
  sessionId = res.sessionId;
  logStatus(`Joined session. Expires in ${res.expiresInSec} sec`);
  return res;
}

function initWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?sessionId=${sessionId}`);
  ws.onopen = () => {
    logStatus("Connected to signaling server.");
    // Kickstart: tell peer we're ready
    ws.send(JSON.stringify({ type: "ready" }));
    setupWebRTC();
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "ready" && isSender) {
      await makeOffer();
    } else if (msg.type === "offer" && !isSender) {
      await handleOffer(msg.offer);
    } else if (msg.type === "answer" && isSender) {
      await pc.setRemoteDescription(msg.answer);
    } else if (msg.type === "candidate") {
      try { await pc.addIceCandidate(msg.candidate); } catch(e){ console.warn(e); }
    }
  };
  ws.onclose = () => logStatus("Signaling disconnected.");
}

function setupWebRTC() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });
  pc.onicecandidate = (ev) => {
    if (ev.candidate) ws?.send(JSON.stringify({ type: "candidate", candidate: ev.candidate }));
  };
  pc.onconnectionstatechange = () => {
    logStatus(`P2P: ${pc.connectionState}`);
  };
  if (isSender) {
    dc = pc.createDataChannel("file");
    setupDataChannel();
  } else {
    pc.ondatachannel = (ev) => {
      dc = ev.channel;
      setupDataChannel();
    };
  }
}

function setupDataChannel() {
  dc.binaryType = "arraybuffer";
  dc.onopen = () => {
    logStatus("P2P channel open.");
    $sendBtn.disabled = !isSender;
  };
  dc.onclose = () => logStatus("P2P channel closed.");
  dc.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      const meta = JSON.parse(data);
      expectedSize = meta.size;
      filename = meta.filename || filename;
      mime = meta.mime || mime;
      recvBuffer = [];
      recvSize = 0;
      $recvProg.value = 0;
    } else {
      recvBuffer.push(data);
      recvSize += data.byteLength;
      $recvProg.value = Math.round((recvSize / expectedSize) * 100);
      if (recvSize >= expectedSize) {
        const blob = new Blob(recvBuffer, { type: mime });
        const url = URL.createObjectURL(blob);
        $downloadLink.href = url;
        $downloadLink.download = filename;
        $downloadLink.classList.remove("hidden");
        recvBuffer = [];
        recvSize = 0;
      }
    }
  };
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws?.send(JSON.stringify({ type: "offer", offer }));
}

async function handleOffer(offer) {
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws?.send(JSON.stringify({ type: "answer", answer }));
}

// Fallback upload if P2P not available or for simplicity
async function uploadFallback(file) {
  const arrayBuf = await file.arrayBuffer();
  if (arrayBuf.byteLength > 5 * 1024 * 1024) {
    alert("Max 5 MB allowed in fallback.");
    return;
  }
  const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
  const res = await api("/api/upload", {
    method: "POST",
    body: JSON.stringify({ sessionId, filename: file.name, mime: file.type, dataB64: b64 })
  });
  if (!res.ok) { alert(res.error || "Upload failed"); return; }
  logStatus("Fallback upload completed.");
}

// UI handlers
$btnCreate.addEventListener("click", createSession);
$btnJoin.addEventListener("click", async () => {
  const code = $codeInput.value.trim();
  if (code.length !== 4) { alert("Enter 4 digits"); return; }
  const ok = await resolveCode(code);
  if (ok) {
    isSender = false;
    initWS();
    $transfer.classList.remove("hidden");
  }
});

$btnScan.addEventListener("click", () => {
  $scanArea.classList.remove("hidden");
  const html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 },
    (decoded) => {
      html5QrCode.stop();
      $scanArea.classList.add("hidden");
      try {
        const url = new URL(decoded);
        const code = url.searchParams.get("code");
        if (code) {
          $codeInput.value = code;
          $btnJoin.click();
        }
      } catch(e) {
        alert("Invalid QR");
      }
    },
    (err) => {}
  );
});
els("#stopScan").addEventListener("click", () => {
  location.reload();
});

$fileInput.addEventListener("change", () => {
  $sendBtn.disabled = !$fileInput.files?.length;
});

$sendBtn.addEventListener("click", async () => {
  const file = $fileInput.files?.[0];
  if (!file) return;
  if (dc && dc.readyState === "open") {
    // Send metadata
    dc.send(JSON.stringify({ filename: file.name, size: file.size, mime: file.type }));
    // Stream chunks
    const reader = file.stream().getReader();
    let sent = 0;
    $sendProg.value = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const chunk = value.subarray(offset, Math.min(offset + MAX_CHUNK, value.byteLength));
        dc.send(chunk);
        sent += chunk.byteLength;
        $sendProg.value = Math.round((sent / file.size) * 100);
        offset += chunk.byteLength;
      }
      // backpressure
      await new Promise(r => setTimeout(r));
    }
    logStatus("P2P send complete.");
  } else {
    await uploadFallback(file);
  }
});

// If session was created here, show transfer area for sender too
$btnCreate.addEventListener("click", () => {
  $transfer.classList.remove("hidden");
});
