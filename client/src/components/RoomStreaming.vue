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
        :muted="false"
      />
    </div>

    <div v-if="error" class="error-message">
      {{ error }}
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted, watch } from 'vue';
import Controls from './Controls.vue';
import VideoPlayer from './VideoPlayer.vue';

// Constants
const WS_URL = 'ws://localhost:3000';
const PC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// State
const ws = ref(null);
const roomId = ref('');
const localStream = ref(null);
const remoteStreams = ref(new Map());
const peerConnections = ref(new Map());
const isStreaming = ref(false);
const isViewing = ref(false);
const isRecording = ref(false);
const error = ref(null);

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
  console.log('Received message:', message.type);

  try {
    switch (message.type) {
      case 'user-joined':
        if (isViewing.value || message.isViewer) {
          await createOffer(message.userId);
        }
        break;
      case 'offer':
        await handleOffer(message);
        break;
      case 'answer':
        await handleAnswer(message);
        break;
      case 'ice-candidate':
        await handleIceCandidate(message);
        break;
      case 'user-left':
        handleUserLeft(message.userId);
        break;
    }
  } catch (err) {
    error.value = `Error processing message: ${err.message}`;
    console.error(err);
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
      audio: true
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
  const pc = new RTCPeerConnection(PC_CONFIG);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({
        type: 'ice-candidate',
        targetUserId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    console.log('Received track from:', targetUserId);
    remoteStreams.value.set(targetUserId, event.streams[0]);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE connection state (${targetUserId}):`, pc.iceConnectionState);
  };

  peerConnections.value.set(targetUserId, pc);
  return pc;
};

const createOffer = async (targetUserId) => {
  const pc = createPeerConnection(targetUserId);

  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

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
};

const handleOffer = async (message) => {
  const pc = createPeerConnection(message.userId);

  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

  await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  sendMessage({
    type: 'answer',
    targetUserId: message.userId,
    answer
  });
};

const handleAnswer = async (message) => {
  const pc = peerConnections.value.get(message.userId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
  }
};

const handleIceCandidate = async (message) => {
  const pc = peerConnections.value.get(message.userId);
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
  }
};

// Utility Functions
const sendMessage = (message) => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({
      ...message,
      roomId: roomId.value,
      isViewer: isViewing.value
    }));
  }
};

const joinRoom = (isViewOnly) => {
  sendMessage({
    type: 'join-room',
    isViewer: isViewOnly
  });
};

const cleanup = () => {
  if (localStream.value) {
    localStream.value.getTracks().forEach(track => track.stop());
    localStream.value = null;
  }

  peerConnections.value.forEach(pc => pc.close());
  peerConnections.value.clear();
  remoteStreams.value.clear();

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