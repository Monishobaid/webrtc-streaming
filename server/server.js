const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const mediasoup = require("mediasoup");
const { v4: uuid } = require("uuid");

const app = express();
app.use(cors());
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let worker;
const msRooms = new Map(); // roomId => { router, transports, producers, consumers }
const usersByRoom = new Map(); // roomId => [userId]

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: "warn",
  });
  console.log("mediasoup worker created");
  worker.on("died", () => {
    console.error("mediasoup worker died, exiting");
    process.exit(1);
  });
})();

const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
];

wss.on("connection", (ws) => {
  ws.id = uuid();
  ws.isAlive = true;
  console.log(`New WebSocket connection: ${ws.id}`);

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (msg) => {
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error("Error handling message:", err);
      ws.send(JSON.stringify({ type: "error", error: err.message }));
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket closed: ${ws.id}`);
    handleLeave(ws);
  });
});

async function handleMessage(ws, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse message:", err);
    return;
  }

  const { type, roomId } = data;
  console.log(`Received ${type} message from ${ws.id} for room ${roomId}`);

  switch (type) {
    case "join-room":
      return handleJoin(ws, data);
    case "get-rtp-capabilities":
      return sendRtpCapabilities(ws, roomId);
    case "create-send-transport":
      return createTransport(ws, roomId, "send");
    case "create-recv-transport":
      return createTransport(ws, roomId, "recv");
    case "connect-transport":
      return connectTransport(ws, data);
    case "produce":
      return handleProduce(ws, data);
    case "get-producers":
      return sendProducerList(ws, roomId);
    case "consume":
      return handleConsume(ws, data);
    case "resume-consumer":
      return handleResume(ws, data);
    case "leave-room":
      return handleLeave(ws);
    default:
      console.warn(`Unknown message type: ${type}`);
  }
}

async function handleJoin(ws, { roomId, isViewer }) {
  console.log(
    `User ${ws.id} joining room ${roomId} as ${
      isViewer ? "viewer" : "broadcaster"
    }`
  );

  ws.currentRoom = roomId;
  ws.isViewer = isViewer;

  // Track users in room
  if (!usersByRoom.has(roomId)) {
    usersByRoom.set(roomId, new Set());
  }
  usersByRoom.get(roomId).add(ws.id);

  const room = await getOrCreateRoom(roomId);

  ws.send(
    JSON.stringify({
      type: "room-joined",
      roomId,
      isViewer,
      userCount: usersByRoom.get(roomId).size,
    })
  );
}

function sendRtpCapabilities(ws, roomId) {
  const room = msRooms.get(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", error: "Room not found" }));
    return;
  }

  ws.send(
    JSON.stringify({
      type: "rtp-capabilities",
      rtpCapabilities: room.router.rtpCapabilities,
    })
  );
}

async function createTransport(ws, roomId, direction) {
  const room = await getOrCreateRoom(roomId);

  try {
    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      appData: { userId: ws.id, direction },
    });

    console.log(
      `Created ${direction} transport ${transport.id} for user ${ws.id}`
    );

    room.transports.set(transport.id, transport);

    // Listen for transport close
    transport.on("dtlsstatechange", (dtlsState) => {
      console.log(`Transport ${transport.id} dtls state: ${dtlsState}`);
      if (dtlsState === "closed") {
        console.log(`Transport ${transport.id} closed`);
        transport.close();
      }
    });

    ws.send(
      JSON.stringify({
        type: "transport-created",
        direction,
        transportOptions: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      })
    );
  } catch (err) {
    console.error(`Error creating transport:`, err);
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to create transport: ${err.message}`,
      })
    );
  }
}

async function connectTransport(ws, { transportId, dtlsParameters }) {
  const room = msRooms.get(ws.currentRoom);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", error: "Room not found" }));
    return;
  }

  const transport = room.transports.get(transportId);
  if (!transport) {
    ws.send(JSON.stringify({ type: "error", error: "Transport not found" }));
    return;
  }

  try {
    await transport.connect({ dtlsParameters });
    console.log(`Transport ${transportId} connected`);
    ws.send(JSON.stringify({ type: "transport-connected", transportId }));
  } catch (err) {
    console.error(`Error connecting transport:`, err);
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to connect transport: ${err.message}`,
      })
    );
  }
}

async function handleProduce(ws, { transportId, kind, rtpParameters }) {
  const room = msRooms.get(ws.currentRoom);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", error: "Room not found" }));
    return;
  }

  const transport = room.transports.get(transportId);
  if (!transport) {
    ws.send(JSON.stringify({ type: "error", error: "Transport not found" }));
    return;
  }

  try {
    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { userId: ws.id },
    });

    console.log(`User ${ws.id} produced ${kind} with id ${producer.id}`);

    room.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      console.log(`Producer ${producer.id} closed due to transport close`);
      room.producers.delete(producer.id);
    });

    // Notify all viewers in the room about the new producer
    wss.clients.forEach((client) => {
      if (
        client !== ws &&
        client.currentRoom === ws.currentRoom &&
        client.isViewer &&
        client.readyState === WebSocket.OPEN
      ) {
        console.log(
          `Notifying viewer ${client.id} about new producer ${producer.id}`
        );
        client.send(
          JSON.stringify({
            type: "new-producer",
            producerId: producer.id,
            producerUserId: ws.id,
            kind,
          })
        );
      }
    });

    ws.send(JSON.stringify({ type: "produced", producerId: producer.id }));
  } catch (err) {
    console.error(`Error producing:`, err);
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to produce: ${err.message}`,
      })
    );
  }
}

function sendProducerList(ws, roomId) {
  const room = msRooms.get(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", error: "Room not found" }));
    return;
  }

  const list = Array.from(room.producers.values()).map((p) => ({
    producerId: p.id,
    producerUserId: p.appData.userId,
    kind: p.kind,
  }));

  console.log(`Sending ${list.length} producers to user ${ws.id}`);
  ws.send(JSON.stringify({ type: "producers", producers: list }));
}

async function handleConsume(ws, { transportId, producerId, rtpCapabilities }) {
  const room = msRooms.get(ws.currentRoom);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", error: "Room not found" }));
    return;
  }

  const transport = room.transports.get(transportId);
  if (!transport) {
    ws.send(JSON.stringify({ type: "error", error: "Transport not found" }));
    return;
  }

  const producer = room.producers.get(producerId);
  if (!producer) {
    ws.send(JSON.stringify({ type: "error", error: "Producer not found" }));
    return;
  }

  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    ws.send(
      JSON.stringify({ type: "error", error: "Cannot consume this producer" })
    );
    return;
  }

  try {
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused, will resume after client set up
    });

    console.log(
      `User ${ws.id} consuming ${producer.kind} producer ${producerId} with consumer ${consumer.id}`
    );

    room.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () => {
      console.log(`Consumer ${consumer.id} closed due to transport close`);
      room.consumers.delete(consumer.id);
    });

    ws.send(
      JSON.stringify({
        type: "consumed",
        consumerParameters: {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          producerUserId: producer.appData.userId,
        },
      })
    );
  } catch (err) {
    console.error(`Error consuming:`, err);
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to consume: ${err.message}`,
      })
    );
  }
}

async function handleResume(ws, { consumerId }) {
  const room = msRooms.get(ws.currentRoom);
  if (!room) return;

  const consumer = room.consumers.get(consumerId);
  if (!consumer) {
    ws.send(JSON.stringify({ type: "error", error: "Consumer not found" }));
    return;
  }

  try {
    console.log(`Resuming consumer ${consumerId}`);
    await consumer.resume();
    ws.send(
      JSON.stringify({
        type: "consumer-resumed",
        consumerId,
        kind: consumer.kind,
      })
    );
  } catch (err) {
    console.error(`Error resuming consumer:`, err);
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to resume consumer: ${err.message}`,
      })
    );
  }
}

function handleLeave(ws) {
  const roomId = ws.currentRoom;
  if (!roomId) return;

  console.log(`User ${ws.id} leaving room ${roomId}`);

  const room = msRooms.get(roomId);
  if (!room) return;

  // Close all transports for this user
  room.transports.forEach((tr, id) => {
    if (tr.appData.userId === ws.id) {
      console.log(`Closing transport ${id} for user ${ws.id}`);
      tr.close();
      room.transports.delete(id);
    }
  });

  // Close all producers for this user
  room.producers.forEach((pr, id) => {
    if (pr.appData.userId === ws.id) {
      console.log(`Closing producer ${id} for user ${ws.id}`);
      pr.close();
      room.producers.delete(id);
    }
  });

  // Close all consumers for this user
  room.consumers.forEach((co, id) => {
    if (co.appData.userId === ws.id) {
      console.log(`Closing consumer ${id} for user ${ws.id}`);
      co.close();
      room.consumers.delete(id);
    }
  });

  // Remove user from room tracking
  if (usersByRoom.has(roomId)) {
    usersByRoom.get(roomId).delete(ws.id);

    // Cleanup room if empty
    if (usersByRoom.get(roomId).size === 0) {
      console.log(`Room ${roomId} is empty, cleaning up resources`);
      usersByRoom.delete(roomId);

      // Close router
      if (room.router) {
        room.router.close();
      }

      msRooms.delete(roomId);
    }
  }

  ws.currentRoom = null;
}

async function getOrCreateRoom(roomId) {
  if (msRooms.has(roomId)) return msRooms.get(roomId);

  console.log(`Creating new room: ${roomId}`);

  const router = await worker.createRouter({ mediaCodecs });
  const room = {
    router,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };

  msRooms.set(roomId, room);
  return room;
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.send({ status: "ok", rooms: msRooms.size });
});

// Handle ping/pong to detect dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`WebSocket ${ws.id} seems dead, terminating`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
