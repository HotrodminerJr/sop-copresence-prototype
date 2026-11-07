import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';

// LiveKit's RN SDK needs these globals (MediaStream, RTCPeerConnection, etc.)
// installed on the JS engine BEFORE any WebRTC code runs. Call once at boot.
registerGlobals();

import App from './App';

registerRootComponent(App);
