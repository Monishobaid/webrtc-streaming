<template>
  <div class="video-container">
    <video
      :data-user="userId"
      ref="videoRef"
      :muted="muted"
      autoplay
      playsinline
    ></video>
    <div class="label">{{ label }}</div>
    <div class="status" :class="connectionStatus">
      {{ connectionStatus }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';

const props = defineProps({
  stream: {
    type: Object, // Expecting a MediaStream instance
    required: true
  },
  label: {
    type: String,
    required: true
  },
  muted: {
    type: Boolean,
    default: false
  },
  userId: { 
    type: String,
    required: true
  }
});

const videoRef = ref(null);
const connectionStatus = ref('connecting');

// Watch for changes to the stream prop
watch(
  () => props.stream,
  (newStream) => {
    if (videoRef.value && newStream) {
      if (newStream instanceof MediaStream) {
        videoRef.value.srcObject = newStream;
        connectionStatus.value = 'connected';
      } else {
        console.warn("Provided stream is not a MediaStream:", newStream);
      }
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (videoRef.value && props.stream) {
    if (props.stream instanceof MediaStream) {
      videoRef.value.srcObject = props.stream;
      connectionStatus.value = 'connected';
    } else {
      console.warn("Provided stream is not a MediaStream:", props.stream);
    }
  }
});
</script>

<style scoped>
.video-container {
  position: relative;
  width: 100%;
  aspect-ratio: 16/9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}

video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.label {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
}

.status {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  text-transform: capitalize;
}

.status.connecting {
  background: #ff9800;
  color: white;
}

.status.connected {
  background: #4caf50;
  color: white;
}
</style>
