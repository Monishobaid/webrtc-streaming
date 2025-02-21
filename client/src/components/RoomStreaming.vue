<template>
  <div class="streaming-container">
    <Controls
      v-model:roomId="roomId"
      :isStreaming="isStreaming"
      :isViewing="isViewing"
      :isRecording="isRecording"
      @startStream="startStream"
      @stopStream="stopStream"
      @startViewing="startViewing"
      @stopViewing="stopViewing"
      @startRecording="startRecording"
      @stopRecording="stopRecording"
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
        :muted="true"
        :userId="userId"
      />
    </div>

    <div v-if="error" class="error-message">
      {{ error }}
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted, watch, nextTick } from "vue";
import Controls from "./Controls.vue";
import VideoPlayer from "./VideoPlayer.vue";

// Constants
const WS_URL = "ws://localhost:3000";
const PC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// State
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

// WebSocket Connection
const initWebSocket = async () => {
  return new Promise((resolve, reject) => {
    ws.value = new WebSocket(WS_URL);
    ws.value.onopen = () => resolve();
    ws.value.onerror = (error) => reject(error);
    ws.value.onmessage = handleWebSocketMessage;
  });
};

// WebSocket Message Handler
const handleWebSocketMessage = async (event) => {
  const message = JSON.parse(event.data);
  console.log("Received message:", message.type);

  try {
    switch (message.type) {
      case "room-users":
        handleRoomUsers(message.users);
        break;
      case "user-joined":
        if (!isViewing.value) {
          await createOffer(message.userId);
        }
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

// Handle room-users message
const handleRoomUsers = async (users) => {
  if (!isViewing.value) {
    for (const userId of users) {
      await createOffer(userId);
    }
  }
};

// Streaming Controls
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

const startStream = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStream.value = stream;
    isStreaming.value = true;
    await initWebSocket();
    joinRoom(false);
  } catch (err) {
    error.value = `Failed to start streaming: ${err.message}`;
    isStreaming.value = false;
  }
};

const stopStream = () => {
  cleanup();
  isStreaming.value = false;
};

const stopViewing = () => {
  cleanup();
  isViewing.value = false;
};

// WebRTC Functions
const createPeerConnection = (targetUserId) => {
  if (peerConnections.value.has(targetUserId)) {
    return peerConnections.value.get(targetUserId);
  }

  const pc = new RTCPeerConnection(PC_CONFIG);

  // --- Add ICE candidate handler ---
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({
        type: "ice-candidate",
        targetUserId,
        candidate: event.candidate,
      });
    }
  };

  // --- Single ontrack handler ---
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      console.log("Received track from:", targetUserId);
      remoteStreams.value.set(targetUserId, event.streams[0]);
      // Force UI update if necessary
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

  // Remove any duplicate ontrack assignment if present

  // ICE restart and connection monitoring code ...
  let iceRestartAttempts = 0;
  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state (${targetUserId}):`, pc.iceConnectionState);
    if (pc.iceConnectionState === "disconnected" && iceRestartAttempts < 3) {
      iceRestartAttempts++;
      restartIceConnection(targetUserId);
    }
  };

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

  // Add local stream tracks if not viewing
  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach((track) => {
      pc.addTrack(track, localStream.value);
    });
  }

  peerConnections.value.set(targetUserId, pc);
  return pc;
};

const createOffer = async (targetUserId) => {
  if (negotiationStates.value.get(targetUserId) === 'pending') return;
  negotiationStates.value.set(targetUserId, 'pending');

  const pc = createPeerConnection(targetUserId);

  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach(track => {
      // Check if this track is already added to the connection.
      const existingSender = pc.getSenders().find(sender => sender.track === track);
      if (!existingSender) {
        pc.addTrack(track, localStream.value);
      }
    });
  }

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    
    await pc.setLocalDescription(offer);
    sendMessage({
      type: 'offer',
      targetUserId,
      offer
    });
    negotiationStates.value.set(targetUserId, 'stable');
  } catch (err) {
    console.error('Offer creation error:', err);
    error.value = `Connection error: ${err.message}`;
    negotiationStates.value.delete(targetUserId);
  }
};


const handleOffer = async (message) => {
  const pc = createPeerConnection(message.userId);

  try {
    // Only handle offers if we're in a stable state
    if (pc.signalingState !== "stable") {
      console.warn("Ignoring offer in non-stable state:", pc.signalingState);
      return;
    }

    // Set the remote description
    await pc.setRemoteDescription(new RTCSessionDescription(message.offer));

    // Create and send an answer
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
      // Only set the remote description if we're expecting an answer
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

// Utility Functions
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

// // Lifecycle Hooks
// onMounted(() => {
//   keepAliveInterval.value = setInterval(() => {
//     if (ws.value?.readyState === WebSocket.OPEN) {
//       ws.value.send(JSON.stringify({ type: 'ping' }));
//     }
//   }, 30000);
// });

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
