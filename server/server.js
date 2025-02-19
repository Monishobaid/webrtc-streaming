const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const viewers = new Map();

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substr(2, 9);
  let currentRoom = null;
  let isViewer = false;

  ws.on('message', async (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'join-room':
        handleJoinRoom(ws, data, userId);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        forwardMessage(data, userId);
        break;
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      leaveRoom(currentRoom, userId);
    }
  });
});

function handleJoinRoom(ws, data, userId) {
  const { roomId, isViewer: joinAsViewer } = data;
  
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
    viewers.set(roomId, new Set());
  }

  isViewer = joinAsViewer;

  if (isViewer) {
    viewers.get(roomId).add(userId);
  } else {
    rooms.get(roomId).set(userId, ws);
  }

  // Notify existing users about new participant
  if (!isViewer) {
    rooms.get(roomId).forEach((participant, participantId) => {
      if (participantId !== userId) {
        participant.send(JSON.stringify({
          type: 'user-joined',
          userId: userId
        }));
      }
    });
  }

  // Send existing users to new participant
  const existingUsers = Array.from(rooms.get(roomId).keys());
  ws.send(JSON.stringify({
    type: 'room-users',
    users: existingUsers
  }));
}

function forwardMessage(data, senderId) {
  const { targetUserId, roomId } = data;
  const room = rooms.get(roomId);
  
  if (room) {
    const targetWs = room.get(targetUserId);
    if (targetWs) {
      data.userId = senderId;
      targetWs.send(JSON.stringify(data));
    }
  }
}

function leaveRoom(roomId, userId) {
  const room = rooms.get(roomId);
  const roomViewers = viewers.get(roomId);

  if (room) {
    room.delete(userId);
    room.forEach((participant) => {
      participant.send(JSON.stringify({
        type: 'user-left',
        userId: userId
      }));
    });
  }

  if (roomViewers) {
    roomViewers.delete(userId);
  }

  if (room?.size === 0 && roomViewers?.size === 0) {
    rooms.delete(roomId);
    viewers.delete(roomId);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});