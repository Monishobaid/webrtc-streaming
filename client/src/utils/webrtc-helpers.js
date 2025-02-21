export const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceTransportPolicy: "relay", // Force TURN
};

export const createPeerConnection = (onIceCandidate, onTrack) => {
  if (peerConnections.value.has(targetUserId)) {
    return peerConnections.value.get(targetUserId);
  }

  const pc = new RTCPeerConnection(configuration);

  let iceRestartAttempts = 0;
  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state (${targetUserId}):`, pc.iceConnectionState);

    if (pc.iceConnectionState === "disconnected" && iceRestartAttempts < 3) {
      iceRestartAttempts++;
      restartIceConnection(targetUserId);
    }
  };

  if (!isViewing.value && localStream.value) {
    localStream.value.getTracks().forEach((track) => {
      pc.addTrack(track, localStream.value);
    });
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      onIceCandidate(candidate);
    }
  };

  // pc.ontrack = onTrack;

  pc.addEventListener("signalingstatechange", () => {
    console.log(`Signaling state (${targetUserId}):`, pc.signalingState);
  });

  return pc;
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

export const addTracksToConnection = (pc, stream) => {
  stream.getTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });
};

// Add these to createPeerConnection
let connectionTimer;
pc.onconnectionstatechange = () => {
  console.log(`Connection state (${targetUserId}):`, pc.connectionState);
  
  if (pc.connectionState === 'connected') {
    connectionTimer = setInterval(() => {
      pc.getStats().then(stats => {
        const hasActiveConnection = [...stats.values()].some(
          report => report.type === 'candidate-pair' && report.state === 'succeeded'
        );
        if (!hasActiveConnection) restartIceConnection(targetUserId);
      });
    }, 5000);
  } else {
    clearInterval(connectionTimer);
  }
};
