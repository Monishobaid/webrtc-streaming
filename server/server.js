const WebSocket = require("ws");
const fs = require("fs");
const http = require("http");
const express = require("express");
const path = require("path");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());



const server = http.createServer(app);

// const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const viewers = new Map();

wss.on("connection", (ws) => {
  const userId = Math.random().toString(36).substr(2, 9);
  let currentRoom = null;
  let isViewer = false;

  ws.on("message", async (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case "join-room":
        handleJoinRoom(ws, data, userId);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        forwardMessage(data, userId);
        break;
    }
  });

  ws.on("close", () => {
    if (currentRoom) {
      leaveRoom(currentRoom, userId);
    }
  });
});

function handleJoinRoom(ws, data, userId) {
  const { roomId, isViewer: joinAsViewer } = data;

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
    viewers.set(roomId, new Map());
  }

  isViewer = joinAsViewer;

  if (isViewer) {
    viewers.get(roomId).set(userId, ws);
  } else {
    rooms.get(roomId).set(userId, ws);
  }

  // Notify existing streamers about new viewer
  if (isViewer) {
    rooms.get(roomId).forEach((participant, participantId) => {
      participant.send(
        JSON.stringify({
          type: "user-joined",
          userId: userId,
          isViewer: true,
        })
      );
    });
  }

  // Send existing streamers to new participant
  const existingUsers = Array.from(rooms.get(roomId).keys());
  ws.send(
    JSON.stringify({
      type: "room-users",
      users: existingUsers,
    })
  );
}

function forwardMessage(data, senderId) {
  if (
    data.type === "answer" &&
    rooms.get(data.roomId)?.get(data.targetUserId)
  ) {
    const lastAnswer = rooms.get(data.roomId).get(data.targetUserId).lastAnswer;
    if (lastAnswer === data.answer.sdp) return;
    rooms.get(data.roomId).get(data.targetUserId).lastAnswer = data.answer.sdp;
  }

  // Forward to streamers
  const roomStreamers = rooms.get(data.roomId);
  if (roomStreamers?.has(data.targetUserId)) {
    roomStreamers
      .get(data.targetUserId)
      .send(JSON.stringify({ ...data, userId: senderId }));
  }

  // Forward to viewers
  const roomViewers = viewers.get(data.roomId);
  if (roomViewers?.has(data.targetUserId)) {
    roomViewers
      .get(data.targetUserId)
      .send(JSON.stringify({ ...data, userId: senderId }));
  }
}

function leaveRoom(roomId, userId) {
  const notifyAll = (wsMap) => {
    wsMap?.forEach((participant, id) => {
      if (id !== userId) {
        participant.send(
          JSON.stringify({
            type: "user-left",
            userId,
          })
        );
      }
    });
  };

  notifyAll(rooms.get(roomId));
  notifyAll(viewers.get(roomId));

  // Remove from streamers
  if (rooms.has(roomId)) {
    rooms.get(roomId).delete(userId);
  }

  // Remove from viewers
  if (viewers.has(roomId)) {
    viewers.get(roomId).delete(userId);
  }

  // Notify remaining users
  rooms.get(roomId)?.forEach((participant) => {
    participant.send(
      JSON.stringify({
        type: "user-left",
        userId: userId,
      })
    );
  });

  // Cleanup empty rooms
  if (rooms.get(roomId)?.size === 0 && viewers.get(roomId)?.size === 0) {
    rooms.delete(roomId);
    viewers.delete(roomId);
  }
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});

