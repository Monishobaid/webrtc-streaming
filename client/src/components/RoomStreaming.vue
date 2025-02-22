<template>
  <div class="streaming-container">
    <Controls
      v-model:roomId="roomId"
      :isStreaming="isStreaming"
      :isViewing="isViewing"
      @startViewing="startViewing"
      @stopViewing="stopViewing"
      @startStream="startStream"
      @stopStream="stopStream"
    />

    <div class="video-grid">
      <VideoPlayer
        v-if="localStream && !isViewing"
        :stream="localStream"
        label="Local Stream"
        :muted="true"
      />
      <VideoPlayer
        v-for="[userId, stream] in remoteStreams"
        :key="userId"
        :stream="stream"
        :label="`Remote Stream (${userId})`"
        :muted="false"
        :userId="userId"
      />
    </div>

    <div v-if="error" class="error-message">
      {{ error }}
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted, nextTick } from "vue";
import Controls from "./Controls.vue";
import VideoPlayer from "./VideoPlayer.vue";

// Constants and configuration
const WS_URL = "wss://localhost:3000";
const PC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// State variables
const ws = ref(null);
const roomId = ref("");
const localStream = ref(null);
const remoteStreams = ref(new Map());
const peerConnections = ref(new Map());
const negotiationStates = ref(new Map());
const isStreaming = ref(false);
const isViewing = ref(false);
const isRecording = ref(false);
const error = ref(null);
const keepAliveInterval = ref(null);

// MediaRecorder variables
let mediaRecorder = null;
let recordedChunks = [];

// WebSocket setup and message handling
const initWebSocket = async () => {
  return new Promise((resolve, reject) => {
    ws.value = new WebSocket(WS_URL);
    console.log(ws.value, "ws");
    ws.value.onopen = () => {
      console.log("WebSocket connection established");
      resolve();
    };
    ws.value.onerror = (event) => {
      console.error("WebSocket encountered an error:", event);
      reject(new Error(`WebSocket error: ${event.type}`));
    };
    ws.value.onclose = (event) => {
      console.warn("WebSocket closed:", event);
    };
    ws.value.onmessage = handleWebSocketMessage;
  });
};



const handleWebSocketMessage = async (event) => {
  const message = JSON.parse(event.data);
  console.log("Received message:", message.type);
  try {
    switch (message.type) {
      case "room-users":
        await handleRoomUsers(message.users);
        break;
      case "user-joined":
        if (!isViewing.value) await createOffer(message.userId);
        break;
      case "offer":
        await handleOffer(message);
        break;
      case "answer":
        await handleAnswer(message);
        break;
      case "ice-candidate":
        await handleIceCandidate(message);
        break;
      case "user-left":
        handleUserLeft(message.userId);
        break;
    }
  } catch (err) {
    error.value = `Error processing message: ${err.message}`;
    console.error(err);
  }
};

const handleRoomUsers = async (users) => {
  if (!isViewing.value) {
    for (const userId of users) {
      await createOffer(userId);
    }
  }
};

// Streaming and viewing controls
const startViewing = async () => {
  try {
    isViewing.value = true;
    await initWebSocket();
    joinRoom(true);
  } catch (err) {
    error.value = `Failed to start viewing: ${err.message}`;
    isViewing.value = false;
  }
};


const stopViewing = () => {
  cleanup();
  isViewing.value = false;
};

const startStream = async () => {
  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      throw new Error("getUserMedia is not supported in this environment.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStream.value = stream;
    isStreaming.value = true;
    await initWebSocket();
    joinRoom(false);
    startRecording();
  } catch (err) {
    console.error(err);
    // Fallback to use err itself if err.message is undefined
    error.value = `Failed to start streaming: ${err.message || err}`;
    isStreaming.value = false;
  }
};



const stopStream = () => {
  // Stop recording if it's active
  if (isRecording.value) stopRecording();
  cleanup();
  isStreaming.value = false;
};

// Recording functions using MediaRecorder
const startRecording = () => {
  if (!localStream.value) {
    error.value = "No local stream available for recording.";
    return;
  }
  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(localStream.value, {
      mimeType: "video/webm; codecs=vp9",
    });
  } catch (e) {
    error.value = "MediaRecorder is not supported in this browser.";
    console.error(e);
    return;
  }
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    // Automatically trigger a download of the recorded video
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = "recorded_stream.webm";
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
  };
  mediaRecorder.start();
  isRecording.value = true;
};

const stopRecording = () => {
  if (mediaRecorder && isRecording.value) {
    mediaRecorder.stop();
    isRecording.value = false;
  }
};

// WebRTC functions
const createPeerConnection = (targetUserId) => {
  if (peerConnections.value.has(targetUserId)) {
    return peerConnections.value.get(targetUserId);
  }

  const pc = new RTCPeerConnection(PC_CONFIG);

  // ICE candidate exchange
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({
        type: "ice-candidate",
        targetUserId,
        candidate: event.candidate,
      });
    }
  };

  // ontrack event for remote streams
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteStreams.value.set(targetUserId, event.streams[0]);
      // Force reactivity update
      remoteStreams.value = new Map(remoteStreams.value);
      nextTick(() => {
        const videoElement = document.querySelector(
          `video[data-user="${targetUserId}"]`
        );
        if (videoElement) {
          videoElement.srcObject = event.streams[0];
          videoElement
            .play()
            .catch((err) => console.error("Error playing video:", err));
        }
      });
    }
  };

  // ICE restart mechanism
  let iceRestartAttempts = 0;
  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state (${targetUserId}):`, pc.iceConnectionState);
    if (pc.iceConnectionState === "disconnected" && iceRestartAttempts < 3) {
      iceRestartAttempts++;
      restartIceConnection(targetUserId);
    }
  };

  // Connection monitoring with periodic stats check
  let connectionTimer;
  pc.onconnectionstatechange = () => {
    console.log(`Connection state (${targetUserId}):`, pc.connectionState);
    if (pc.connectionState === "connected") {
      connectionTimer = setInterval(() => {
        pc.getStats().then((stats) => {
          const hasActiveConnection = [...stats.values()].some(
            (report) =>
              report.type === "candidate-pair" && report.state === "succeeded"
          );
          if (!hasActiveConnection) restartIceConnection(targetUserId);
        });
      }, 5000);
    } else {
      clearInterval(connectionTimer);
    }
  };

  // Add local stream tracks if not viewing (avoiding duplicates)
  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach((track) => {
      const senderExists = pc
        .getSenders()
        .some((sender) => sender.track === track);
      if (!senderExists) {
        pc.addTrack(track, localStream.value);
      }
    });
  }

  peerConnections.value.set(targetUserId, pc);
  return pc;
};

const createOffer = async (targetUserId) => {
  if (negotiationStates.value.get(targetUserId) === "pending") return;
  negotiationStates.value.set(targetUserId, "pending");

  const pc = createPeerConnection(targetUserId);
  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);
    sendMessage({
      type: "offer",
      targetUserId,
      offer,
    });
    negotiationStates.value.set(targetUserId, "stable");
  } catch (err) {
    console.error("Offer creation error:", err);
    error.value = `Connection error: ${err.message}`;
    negotiationStates.value.delete(targetUserId);
  }
};

const handleOffer = async (message) => {
  const pc = createPeerConnection(message.userId);
  try {
    if (pc.signalingState !== "stable") {
      console.warn("Ignoring offer in non-stable state:", pc.signalingState);
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMessage({
      type: "answer",
      targetUserId: message.userId,
      answer,
    });
  } catch (err) {
    console.error("Error handling offer:", err);
    error.value = `Failed to handle offer: ${err.message}`;
  }
};

const handleAnswer = async (message) => {
  const pc = peerConnections.value.get(message.userId);
  if (pc) {
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(
          new RTCSessionDescription(message.answer)
        );
      } else {
        console.warn("Ignoring answer in state:", pc.signalingState);
      }
    } catch (err) {
      console.error("Error handling answer:", err);
      error.value = `Failed to handle answer: ${err.message}`;
    }
  }
};

const handleIceCandidate = async (message) => {
  const pc = peerConnections.value.get(message.userId);
  if (pc && pc.remoteDescription && message.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
    } catch (err) {
      if (!err.message.includes("Duplicate candidate")) {
        console.error("ICE candidate error:", err);
      }
    }
  }
};

const restartIceConnection = async (targetUserId) => {
  const pc = peerConnections.value.get(targetUserId);
  if (!pc) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendMessage({
      type: "offer",
      targetUserId,
      offer,
    });
  } catch (err) {
    console.error("ICE restart failed:", err);
  }
};

const sendMessage = (message) => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(
      JSON.stringify({
        ...message,
        roomId: roomId.value,
        isViewer: isViewing.value,
      })
    );
  }
};

const joinRoom = (isViewOnly) => {
  sendMessage({
    type: "join-room",
    isViewer: isViewOnly,
  });
};

const cleanup = () => {
  if (localStream.value) {
    localStream.value.getTracks().forEach((track) => track.stop());
    localStream.value = null;
  }
  peerConnections.value.forEach((pc) => pc.close());
  peerConnections.value.clear();
  remoteStreams.value.clear();
  negotiationStates.value.clear();
  if (ws.value) {
    ws.value.close();
    ws.value = null;
  }
  error.value = null;
};

const handleUserLeft = (userId) => {
  const pc = peerConnections.value.get(userId);
  if (pc) {
    pc.close();
    peerConnections.value.delete(userId);
  }
  remoteStreams.value.delete(userId);
};

onUnmounted(() => {
  cleanup();
  clearInterval(keepAliveInterval.value);
});
</script>

<style scoped>
.streaming-container {
  padding: 20px;
}
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 20px;
  margin-top: 20px;
}
.error-message {
  color: red;
  margin-top: 10px;
  padding: 10px;
  background-color: #ffebee;
  border-radius: 4px;
}
</style>
