export const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  
  export const createPeerConnection = (onIceCandidate, onTrack) => {
    const pc = new RTCPeerConnection(configuration);
    
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        onIceCandidate(candidate);
      }
    };
    
    pc.ontrack = onTrack;
    
    return pc;
  };
  
  export const addTracksToConnection = (pc, stream) => {
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });
  };