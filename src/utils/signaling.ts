// signaling.ts - WebRTC Signaling Service (Complete Fixed Version)


interface SignalingMessage {
  type: 'offer' | 'answer';
  sdp: string;
  pin: string;
  publicKey?: string;
  timestamp: number;
  iceServer?: string;
  chunkSize?: number;
}

// IMPORTANT: Update this URL to your signaling server
// Local network: 'ws://192.168.1.X:8080' (replace X with your server IP)
// Internet: 'wss://your-domain.com'
// Same browser testing: '' (empty string for BroadcastChannel)
const SIGNALING_SERVER_URL = "wss://websocket-jhdc.onrender.com/ws";

class SignalingService {
  private static instance: SignalingService;
  private signalingChannel: BroadcastChannel | null = null;
  private websocket: WebSocket | null = null;
  private messageHandlers: Map<string, (message: SignalingMessage) => void>;
  private reconnectTimeout: number | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private connectionReady: Promise<void>;
  private connectionReadyResolve?: () => void;

  private constructor() {
    this.messageHandlers = new Map();
    this.connectionReady = new Promise((resolve) => {
      this.connectionReadyResolve = resolve;
    });
    this.initializeSignaling();
  }

  private async initializeSignaling() {
    if (SIGNALING_SERVER_URL) {
      console.log('Attempting WebSocket connection to:', SIGNALING_SERVER_URL);
      this.connectWebSocket();
    } else {
      // console.log('Using BroadcastChannel for same-browser signaling');
      this.initBroadcastChannel();
      this.connectionReadyResolve?.();
    }
  }

  private initBroadcastChannel() {
    this.signalingChannel = new BroadcastChannel('webrtc-signaling');
    
    this.signalingChannel.onmessage = (event) => {
      const message: SignalingMessage = event.data;
      // console.log('Received via BroadcastChannel:', message.type, 'PIN:', message.pin);
      
      const handler = this.messageHandlers.get(message.pin);
      if (handler) {
        // console.log('Handler found for PIN:', message.pin);
        handler(message);
      }
    };

    // console.log('BroadcastChannel initialized');
  }

  private connectWebSocket() {
    if (this.isConnecting || !SIGNALING_SERVER_URL) return;
    
    this.isConnecting = true;

    try {
      this.websocket = new WebSocket(SIGNALING_SERVER_URL);

      this.websocket.onopen = () => {
        // console.log('WebSocket connected to signaling server');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.connectionReadyResolve?.();
        
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle status/error messages
          if (data.status && !data.type) {
            // console.log('Server status:', data.message || data.status);
            return;
          }

          if (data.error && !data.type) {
            console.error('Server error:', data.error);
            return;
          }

          // Handle offer_available notification
          if (data.type === 'offer_available') {
            // console.log('Offer available for PIN:', data.pin);
            const handler = this.messageHandlers.get(data.pin);
            if (handler) {
              // Request the offer
              this.websocket?.send(JSON.stringify({
                type: 'request_offer',
                pin: data.pin
              }));
            }
            return;
          }

          // Handle offer/answer messages
          const message: SignalingMessage = data;
          if (message.type === 'offer' || message.type === 'answer') {
            // console.log('Received via WebSocket:', message.type, 'PIN:', message.pin);
            
            const handler = this.messageHandlers.get(message.pin);
            if (handler) {
              // console.log('Handler found for PIN:', message.pin);
              handler(message);
            } else {
              // console.log('No handler for PIN:', message.pin);
            }
          }
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };

      this.websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
      };

      this.websocket.onclose = () => {
        console.log('WebSocket disconnected');
        this.isConnecting = false;
        this.websocket = null;
        
        // Reset connection ready promise
        this.connectionReady = new Promise((resolve) => {
          this.connectionReadyResolve = resolve;
        });
        
        // Attempt reconnection with exponential backoff
        if (SIGNALING_SERVER_URL && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          this.reconnectAttempts++;
          
          // console.log(`Reconnecting in ${delay/1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          
          this.reconnectTimeout = window.setTimeout(() => {
            this.reconnectTimeout = null;
            this.connectWebSocket();
          }, delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          // console.log('Max reconnection attempts reached, falling back to BroadcastChannel');
          this.initBroadcastChannel();
        }
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.isConnecting = false;
      this.initBroadcastChannel();
    }
  }

  static getInstance(): SignalingService {
    if (!SignalingService.instance) {
      SignalingService.instance = new SignalingService();
    }
    return SignalingService.instance;
  }

  generatePIN(): string {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    // console.log('Generated PIN:', pin);
    return pin;
  }

  private async waitForConnection(): Promise<void> {
    // Wait up to 5 seconds for connection
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    });
    
    await Promise.race([this.connectionReady, timeout]);
  }

  private async sendMessage(message: SignalingMessage): Promise<void> {
    // console.log('Sending message:', message.type, 'PIN:', message.pin);
    
    await this.waitForConnection();
    
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(message));
      // console.log('Sent via WebSocket');
    } else if (this.signalingChannel) {
      this.signalingChannel.postMessage(message);
      // console.log('Sent via BroadcastChannel');
    } else {
      console.error('No signaling method available');
      throw new Error('Signaling unavailable - please check server connection');
    }
  }

  async sendOffer(pin: string, sdp: string, options: {
    publicKey?: string;
    iceServer?: string;
    chunkSize?: number;
  }): Promise<void> {
    const message: SignalingMessage = {
      type: 'offer',
      sdp,
      pin,
      publicKey: options.publicKey,
      iceServer: options.iceServer,
      chunkSize: options.chunkSize,
      timestamp: Date.now()
    };

    // console.log('Sending OFFER for PIN:', pin);
    await this.sendMessage(message);
  }

  async sendAnswer(pin: string, sdp: string, publicKey?: string): Promise<void> {
    const message: SignalingMessage = {
      type: 'answer',
      sdp,
      pin,
      publicKey,
      timestamp: Date.now()
    };

    // console.log('Sending ANSWER for PIN:', pin);
    await this.sendMessage(message);
  }

  listenForOffer(pin: string, callback: (offer: SignalingMessage) => void): () => void {
    // console.log('Listening for OFFER on PIN:', pin);
    
    // Store the handler
    this.messageHandlers.set(pin, (message) => {
      if (message.type === 'offer') {
        // console.log('OFFER received for PIN:', pin);
        callback(message);
      }
    });

    // If using WebSocket, request the offer after a brief delay
    setTimeout(() => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        // console.log('Requesting offer from server for PIN:', pin);
        this.websocket.send(JSON.stringify({
          type: 'request_offer',
          pin: pin
        }));
      }
    }, 500);

    return () => {
      // console.log('Stopped listening for PIN:', pin);
      this.messageHandlers.delete(pin);
    };
  }

  listenForAnswer(pin: string, callback: (answer: SignalingMessage) => void): () => void {
    // console.log('Listening for ANSWER on PIN:', pin);
    
    this.messageHandlers.set(pin, (message) => {
      if (message.type === 'answer') {
        // console.log('ANSWER received for PIN:', pin);
        callback(message);
      }
    });

    return () => {
      // console.log('Stopped listening for PIN:', pin);
      this.messageHandlers.delete(pin);
    };
  }

  isConnected(): boolean {
    return (this.websocket?.readyState === WebSocket.OPEN) || (this.signalingChannel !== null);
  }

  cleanup(): void {
    // console.log('Cleaning up signaling service');
    this.messageHandlers.clear();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    
    if (this.signalingChannel) {
      this.signalingChannel.close();
      this.signalingChannel = null;
    }
  }
}

export default SignalingService;
export type { SignalingMessage };