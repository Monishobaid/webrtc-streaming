<template>
  <div>
    <div class="controls">
      <input v-model="roomId" placeholder="Enter Room ID" />
      <button @click="joinRoom(true)">Join as Viewer</button>
      <button @click="startStream">Start Streaming</button>
      <button @click="stopStream">Stop Streaming</button>
      <button @click="leaveRoom">Leave Room</button>
      <div v-if="error" class="error">{{ error }}</div>
      <div v-if="debugInfo" class="debug-info">{{ debugInfo }}</div>
    </div>
    <div class="video-container">
      <div v-if="isStreaming" class="video-box">
        <h3>Your Stream</h3>
        <video id="localVideo" autoplay muted playsinline></video>
      </div>
      <div id="remote-container" class="video-grid">
        <!-- Remote videos get added here -->
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted, nextTick } from "vue";
import * as mediasoupClient from "mediasoup-client";

const WS_URL = "wss://streaming-server-mediasoup.fuelbuddy.in";
const ws = ref(null);
const roomId = ref("");
let localStream = null;
const isStreaming = ref(false);
const isViewing = ref(false);
const error = ref(null);
const debugInfo = ref(null);
const remoteStreams = new Map(); // userId -> MediaStream

let device = null;
let sendTransport = null;
let recvTransport = null;
let producers = [];
let consumers = [];

const initWebSocket = () =>
  new Promise((resolve, reject) => {
    ws.value = new WebSocket(WS_URL);
    ws.value.onopen = () => resolve();
    ws.value.onerror = (e) => reject(new Error(`WebSocket error: ${e.type}`));
    ws.value.onmessage = (e) => handleWebSocketMessage(e);
  });

const handleWebSocketMessage = async (event) => {
  const msg = JSON.parse(event.data);
  console.log("Received message:", msg);

  switch (msg.type) {
    case "rtp-capabilities":
      try {
        await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
        if (isStreaming.value) sendMessage({ type: "create-send-transport" });
        else if (isViewing.value)
          sendMessage({ type: "create-recv-transport" });
      } catch (err) {
        error.value = `Error loading device: ${err.message}`;
        console.error(err);
      }
      break;

    case "transport-created":
      await setupTransport(msg);
      if (msg.direction === "recv") sendMessage({ type: "get-producers" });
      break;

    case "producers":
      for (const p of msg.producers) {
        await consumeProducer(p.producerId, p.producerUserId, p.kind);
      }
      break;

    case "new-producer":
      await consumeProducer(msg.producerId, msg.producerUserId, msg.kind);
      break;

    case "consumed":
      await handleConsumed(msg.consumerParameters);
      break;

    case "consumer-resumed":
      console.log(`Consumer ${msg.consumerId} resumed`);
      break;

    case "error":
      error.value = msg.error;
      console.error(msg.error);
      break;
  }
};

async function setupTransport({ direction, transportOptions }) {
  if (direction === "send") {
    sendTransport = device.createSendTransport(transportOptions);
    sendTransport.on("connect", ({ dtlsParameters }, callback) => {
      sendMessage({
        type: "connect-transport",
        transportId: sendTransport.id,
        dtlsParameters,
      });
      callback();
    });
    sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
      sendMessage({
        type: "produce",
        transportId: sendTransport.id,
        kind,
        rtpParameters,
      });
      callback({ id: Date.now().toString() });
    });
    if (localStream) await produceLocalTracks();
  } else {
    recvTransport = device.createRecvTransport(transportOptions);
    recvTransport.on("connect", ({ dtlsParameters }, callback) => {
      sendMessage({
        type: "connect-transport",
        transportId: recvTransport.id,
        dtlsParameters,
      });
      callback();
    });
  }
}

async function produceLocalTracks() {
  const audioTracks = localStream.getAudioTracks();
  const videoTracks = localStream.getVideoTracks();
  if (audioTracks.length)
    producers.push(await sendTransport.produce({ track: audioTracks[0] }));
  if (videoTracks.length)
    producers.push(await sendTransport.produce({ track: videoTracks[0] }));
}

async function consumeProducer(producerId, producerUserId, kind) {
  if (!recvTransport) return;
  sendMessage({
    type: "consume",
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });
}

async function handleConsumed({
  id,
  producerId,
  kind,
  rtpParameters,
  producerUserId,
}) {
  try {
    const consumer = await recvTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      paused: false,
    });
    consumers.push(consumer);

    let stream = remoteStreams.get(producerUserId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(producerUserId, stream);
    }

    stream.addTrack(consumer.track);
    debugInfo.value = `Consumer ${id} (${kind}) ready`;

    // Render or update the video/audio element
    createOrUpdateRemoteElement(producerUserId, stream);

    // sendMessage({ type: "resume-consumer", consumerId: consumer.id });
    await consumer.resume();
    sendMessage({ type: "resume-consumer", consumerId: consumer.id });
  } catch (err) {
    error.value = `Error consuming: ${err.message}`;
    console.error(err);
  }
}

function createOrUpdateRemoteElement(userId, stream) {
  const container = document.getElementById("remote-container");
  let box = document.getElementById(`box-${userId}`);
  if (!box) {
    box = document.createElement("div");
    box.className = "video-box";
    box.id = `box-${userId}`;

    const label = document.createElement("h4");
    label.textContent = `Stream: ${userId.substring(0, 8)}`;
    box.appendChild(label);

    const video = document.createElement("video");
    video.id = `vid-${userId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // Optional: browsers autoplay better with muted
    video.srcObject = stream;

    box.appendChild(video);
    container.appendChild(box);

    video.play().catch(() => {
      debugInfo.value = "Tap to play video";
    });
  } else {
    const video = document.getElementById(`vid-${userId}`);
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {
        debugInfo.value = "Tap to play video";
      });
    }
  }
}

function createRemoteElement(userId, stream, kind) {
  const container = document.getElementById("remote-container");
  let box = document.getElementById(`box-${userId}`);
  if (!box) {
    box = document.createElement("div");
    box.className = "video-box";
    box.id = `box-${userId}`;
    const label = document.createElement("h4");
    label.textContent = `Stream: ${userId.substring(0, 8)}`;
    box.appendChild(label);
    container.appendChild(box);
  }

  if (kind === "video") {
    let vid = document.getElementById(`vid-${userId}`);
    if (!vid) {
      vid = document.createElement("video");
      vid.id = `vid-${userId}`;
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true; // mute to allow autoplay
      box.appendChild(vid);
    }
    vid.srcObject = stream;
    vid.play().catch(() => (debugInfo.value = "Tap to play video"));
  }

  if (kind === "audio") {
    let aud = document.getElementById(`aud-${userId}`);
    if (!aud) {
      aud = document.createElement("audio");
      aud.id = `aud-${userId}`;
      aud.autoplay = true;
      box.appendChild(aud);
    }
    aud.srcObject = stream;
    aud.play().catch((e) => console.error(e));
  }
}

function sendMessage(msg) {
  if (!ws.value || ws.value.readyState !== WebSocket.OPEN) {
    error.value = "WebSocket not connected";
    return;
  }
  ws.value.send(JSON.stringify({ ...msg, roomId: roomId.value }));
}

async function joinRoom(viewer) {
  if (!roomId.value) return (error.value = "Room ID required");
  await initWebSocket();
  isViewing.value = viewer;
  isStreaming.value = !viewer;
  sendMessage({ type: "join-room", isViewer: viewer });
  device = new mediasoupClient.Device();
  sendMessage({ type: "get-rtp-capabilities" });
}

async function startStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: true,
    });
    isStreaming.value = true;
    await nextTick();
    const lv = document.getElementById("localVideo");
    if (lv) lv.srcObject = localStream;
    await joinRoom(false);
  } catch (e) {
    error.value = `Media error: ${e.message}`;
  }
}

function stopStream() {
  localStream?.getTracks().forEach((t) => t.stop());
  producers.forEach((p) => p.close());
  producers = [];
  cleanup();
  isStreaming.value = false;
}

function leaveRoom() {
  sendMessage({ type: "leave-room" });
  cleanup();
  isViewing.value = false;
  isStreaming.value = false;
}

function cleanup() {
  sendTransport?.close();
  recvTransport?.close();
  ws.value?.close();
  ws.value = null;
  producers = [];
  consumers = [];
  debugInfo.value = null;
  error.value = null;
  const rc = document.getElementById("remote-container");
  if (rc) rc.innerHTML = "";
}

onUnmounted(cleanup);
</script>

<style scoped>
.controls {
  margin-bottom: 16px;
}
.video-container {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-top: 20px;
}
.video-box {
  width: 400px;
  margin-bottom: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 10px;
  background: #f8f8f8;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
}
.video-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  width: 100%;
}
video {
  width: 100%;
  height: 300px;
  background: #333;
  border-radius: 8px;
  object-fit: contain;
}
.error {
  color: red;
  margin-top: 8px;
  padding: 10px;
  background: #ffeeee;
  border-radius: 4px;
}
.debug-info {
  color: #0066cc;
  margin-top: 8px;
  padding: 10px;
  background: #e6f2ff;
  border-radius: 4px;
  font-family: monospace;
}
h3,
h4 {
  margin-top: 0;
  margin-bottom: 8px;
}
button {
  margin-right: 8px;
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #ccc;
  background: #f1f1f1;
  cursor: pointer;
}
button:hover {
  background: #e5e5e5;
}
input {
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #ccc;
  margin-right: 8px;
}
.status-indicator {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  margin-bottom: 8px;
  text-align: center;
}
.connecting {
  background-color: #fff3cd;
  color: #856404;
}
.connected {
  background-color: #d4edda;
  color: #155724;
}
.error {
  background-color: #f8d7da;
  color: #721c24;
}
</style>
