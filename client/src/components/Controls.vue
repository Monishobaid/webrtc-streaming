<template>
  <div class="controls">
    <div class="input-group">
      <input
        :value="roomId"
        @input="$emit('update:roomId', $event.target.value)"
        placeholder="Enter Room ID"
        :disabled="isStreaming || isViewing"
      />
    </div>
    <div class="button-group">
      <button
        @click="$emit('startViewing')"
        :disabled="isStreaming || isViewing || !roomId"
        class="view-button"
      >
        Join as Viewer
      </button>
      <button
        @click="$emit('stopViewing')"
        :disabled="!isViewing"
        class="stop-button"
      >
        Leave Room
      </button>
      <button
        @click="$emit('startStream')"
        :disabled="isStreaming || isViewing || !roomId"
        class="stream-button"
      >
        Start Streaming
      </button>
      <button
        @click="$emit('stopStream')"
        :disabled="!isStreaming"
        class="stop-button"
      >
        Stop Streaming
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  roomId: String,
  isStreaming: Boolean,
  isViewing: Boolean,
});

defineEmits([
  "update:roomId",
  "startStream",
  "stopStream",
  "startViewing",
  "stopViewing",
]);
</script>

<style scoped>
.controls {
  display: flex;
  flex-direction: column;
  gap: 15px;
  background: #f5f5f5;
  padding: 15px;
  border-radius: 8px;
}
.input-group {
  display: flex;
  gap: 10px;
}
.button-group {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}
button {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.view-button {
  background-color: #2196f3;
  color: white;
}
.stream-button {
  background-color: #4caf50;
  color: white;
}
.stop-button {
  background-color: #f44336;
  color: white;
}
button:hover:not(:disabled) {
  opacity: 0.9;
}
</style>
