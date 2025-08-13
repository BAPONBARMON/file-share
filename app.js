const $ = sel => document.querySelector(sel);
const BACKEND_URL = window.BACKEND_URL;

const $otp = $("#otp");
const $status = $("#status");
const $qrCanvas = $("#qr");
const $codeInput = $("#codeInput");
const $btnJoin = $("#btnJoin");
const $btnScan = $("#btnScan");
const $reader = $("#reader");
const $stopScan = $("#stopScan");
const $transferCard = $("#transferCard");
const $sendBtn = $("#sendBtn");
const $fileInput = $("#fileInput");
const $sendProg = $("#sendProg");
const $recvProg = $("#recvProg");
const $downloadLink = $("#downloadLink");

function status(msg){ $status.textContent = msg; console.log(msg); }

// Socket.IO connect
const socket = io(BACKEND_URL, { transports: ["websocket"], timeout: 20000 });

let myId = null;
let peerId = null;
let isInitiator = false;
let pc = null;
let dc = null;
const MAX_FALLBACK = 5 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024;

let recvBuffer = [], recvSize = 0, expectedSize = 0, recvMeta = { filename: "file.bin", mime: "application/octet-stream" };

socket.on("connect", () => { myId = socket.id; status("Connected to backend."); });
socket.on("disconnect", () => status("Disconnected from backend."));

// Receive my OTP
socket.on("otp", ({ otp }) => {
  // show in UI
  $otp.textContent = otp.toString().split("").join(" ");
  // generate QR with ?code= for convenience
  const joinURL = `${location.origin}${location.pathname}?code=${otp}`;
  const qr = new QRious({ element: $qrCanvas, value: joinURL, size: 180 });
});

// If URL has ?code= prefill
const urlParams = new URLSearchParams(location.search);
const codeFromUrl = urlParams.get("code");
if (codeFromUrl) { $codeInput.value = codeFromUrl; }

// Join click
$btnJoin.addEventListener("click", () => {
  const code = ($codeInput.value || "").trim();
  if (code.length !== 4) { alert("Enter 4 digits"); return; }
  isInitiator = true; // the one who enters code will initiate offer
  socket.emit("join", { otp: code });
  status("Trying to pair with partner…");
});

// Pairing established
socket.on("peer-connect", ({ peerId: pid }) => {
  if (peerId && peerId !== pid) return;
  peerId = pid;
  status("Paired! Setting up P2P…");
  setupWebRTC();
  if (isInitiator) makeOffer();
  $("#transferCard").classList.remove("hidden");
});

socket.on("join-error", (e) => alert(e?.message || "Join failed"));

// Signalling relay
socket.on("signal", async ({ from, data }) => {
  if (!pc) return;
  if (data?.type === "offer") {
    await pc.setRemoteDescription(data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { targetId: from, data: answer });
  } else if (data?.type === "answer") {
    await pc.setRemoteDescription(data);
  } else if (data?.candidate) {
    try { await pc.addIceCandidate(data); } catch (e) { console.warn(e); }
  }
});

socket.on("peer-disconnect", () => {
  status("Peer disconnected.");
  cleanupRTC();
});

function setupWebRTC(){
  pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  pc.onicecandidate = ev => { if (ev.candidate) socket.emit("signal", { targetId: peerId, data: ev.candidate }); };
  pc.onconnectionstatechange = () => status("P2P: " + pc.connectionState);
  if (isInitiator) {
    dc = pc.createDataChannel("file");
    setupDC();
  } else {
    pc.ondatachannel = ev => { dc = ev.channel; setupDC(); };
  }
}

function setupDC(){
  dc.binaryType = "arraybuffer";
  dc.onopen = () => { status("P2P channel open."); $sendBtn.disabled = false; };
  dc.onclose = () => status("P2P channel closed.");
  dc.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      // metadata
      try {
        const meta = JSON.parse(ev.data);
        expectedSize = meta.size || 0;
        recvMeta = { filename: meta.filename || "file.bin", mime: meta.mime || "application/octet-stream" };
        recvBuffer = []; recvSize = 0; $recvProg.value = 0;
      } catch {}
    } else {
      recvBuffer.push(ev.data);
      recvSize += ev.data.byteLength;
      if (expectedSize) $recvProg.value = Math.round((recvSize/expectedSize)*100);
      if (expectedSize && recvSize >= expectedSize) finalizeReceive();
    }
  };
}

async function makeOffer(){
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { targetId: peerId, data: offer });
}

function cleanupRTC(){
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  dc = null; pc = null; peerId = null; isInitiator = false;
  $sendBtn.disabled = true;
}

// UI: send file
$fileInput.addEventListener("change", () => { $sendBtn.disabled = !(dc && dc.readyState === "open" && $fileInput.files?.length); });
$sendBtn.addEventListener("click", async () => {
  const file = $fileInput.files?.[0];
  if (!file) return;
  if (!(dc && dc.readyState === "open")) { alert("P2P not ready"); return; }

  // If very large or DC unsupported, we could add a backend fallback (<=5MB). Keeping P2P primary.
  if (file.size > (5*1024*1024)) { alert("Max 5 MB for demo"); return; }

  // send metadata
  dc.send(JSON.stringify({ filename: file.name, size: file.size, mime: file.type }));

  const reader = file.stream().getReader();
  let sent = 0; $sendProg.value = 0;
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
    await new Promise(r => setTimeout(r));
  }
  status("Send complete.");
});

function finalizeReceive(){
  const blob = new Blob(recvBuffer, { type: recvMeta.mime });
  const url = URL.createObjectURL(blob);
  $downloadLink.href = url;
  $downloadLink.download = recvMeta.filename;
  $downloadLink.classList.remove("hidden");
  recvBuffer = []; recvSize = 0; expectedSize = 0;
}

// QR Scan
let html5QrCode = null;
$("#btnScan").addEventListener("click", () => {
  $("#reader").classList.remove("hidden");
  $("#stopScan").classList.remove("hidden");
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 },
    (decoded) => {
      try {
        const u = new URL(decoded);
        const code = u.searchParams.get("code");
        if (code) {
          $codeInput.value = code;
          $btnJoin.click();
          stopScan();
        }
      } catch{}
    }, () => {});
});
$("#stopScan").addEventListener("click", stopScan);
function stopScan(){
  $("#reader").classList.add("hidden");
  $("#stopScan").classList.add("hidden");
  if (html5QrCode) { html5QrCode.stop().catch(()=>{}); html5QrCode = null; }
}
