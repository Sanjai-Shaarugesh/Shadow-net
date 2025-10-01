// signaling-server.ts - WebRTC Signaling Server with Elysia.js & Bun
// Complete working version for cross-network connections
// 
// Installation:
// bun add elysia
//
// Run:
// bun run signaling-server.ts
//
// For cross-network access, ensure:
// 1. Port 8080 is open in firewall
// 2. Run on machine with known IP address
// 3. Update client code with server IP

import { Elysia } from 'elysia';

const PORT = process.env.PORT || 8080;

// Store active PIN connections
interface PinConnection {
  offer: any;
  offerSocket: any;
  timestamp: number;
  clientId: number;
}

const pinConnections = new Map<string, PinConnection>();
const connectedClients = new Set<any>();
let clientCounter = 0;

// Cleanup old PINs every minute
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [pin, data] of pinConnections.entries()) {
    // Remove PINs older than 10 minutes
    if (now - data.timestamp > 10 * 60 * 1000) {
      pinConnections.delete(pin);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`[CLEANUP] Removed ${cleanedCount} expired PIN(s)`);
  }
}, 60 * 1000);

const app = new Elysia()
  // HTTP status endpoint with CORS
  .get('/', ({ set }) => {
    set.headers['Access-Control-Allow-Origin'] = '*';
    set.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    set.headers['Access-Control-Allow-Headers'] = 'Content-Type';
    
    return {
      status: 'running',
      service: 'WebRTC Signaling Server',
      version: '2.0.0',
      activePins: pinConnections.size,
      connectedClients: connectedClients.size
    };
  })
  
  // WebSocket endpoint
  .ws('/ws', {
    open(ws) {
      clientCounter++;
      const clientId = clientCounter;
      
      // Store client metadata in ws.data
      ws.data.clientId = clientId;
      ws.data.isAlive = true;
      
      connectedClients.add(ws);
      
      console.log(`[${clientId}] Client connected`);
      console.log(`[INFO] Total clients: ${connectedClients.size}`);
      
      // Send welcome message
      try {
        ws.send(JSON.stringify({ 
          status: 'connected', 
          clientId,
          message: 'WebRTC Signaling Server Ready'
        }));
      } catch (error: any) {
        console.error(`[${clientId}] Error sending welcome:`, error.message);
      }
    },
    
    message(ws, message) {
      const clientId = ws.data.clientId;
      
      try {
        const msg = typeof message === 'string' ? JSON.parse(message) : message;
        const { type, pin } = msg;

        // Handle request_offer - receiver asking for stored offer
        if (type === 'request_offer') {
          if (!pin || !/^\d{6}$/.test(pin)) {
            ws.send(JSON.stringify({ 
              error: 'Invalid PIN format. Must be 6 digits.',
              received: pin
            }));
            return;
          }

          const connection = pinConnections.get(pin);
          if (connection && connection.offer) {
            console.log(`[${clientId}] Sending stored offer for PIN: ${pin}`);
            ws.send(JSON.stringify(connection.offer));
          } else {
            console.log(`[${clientId}] No offer found for PIN: ${pin}`);
            ws.send(JSON.stringify({ 
              status: 'waiting',
              pin,
              message: 'No offer yet, keep listening'
            }));
          }
          return;
        }

        // Validate PIN format for offer/answer
        if (!pin || !/^\d{6}$/.test(pin)) {
          ws.send(JSON.stringify({ 
            error: 'Invalid PIN format. Must be 6 digits.',
            received: pin
          }));
          console.log(`[${clientId}] Invalid PIN format: ${pin}`);
          return;
        }

        // Handle offer from sender
        if (type === 'offer') {
          // Check if PIN already exists
          if (pinConnections.has(pin)) {
            ws.send(JSON.stringify({ 
              error: 'PIN already in use. Please generate a new PIN.',
              pin 
            }));
            console.log(`[${clientId}] PIN ${pin} already in use`);
            return;
          }

          // Store the offer
          pinConnections.set(pin, {
            offer: msg,
            offerSocket: ws,
            timestamp: Date.now(),
            clientId
          });
          
          ws.send(JSON.stringify({ 
            status: 'offer_stored', 
            pin,
            message: 'Waiting for receiver to connect...'
          }));
          
          console.log(`[${clientId}] Stored offer for PIN: ${pin}`);
          
          // Notify any waiting receivers
          connectedClients.forEach((client) => {
            if (client !== ws) {
              try {
                client.send(JSON.stringify({
                  type: 'offer_available',
                  pin: pin
                }));
              } catch (err: any) {
                console.error(`[${clientId}] Error notifying client:`, err.message);
              }
            }
          });
        } 
        // Handle answer from receiver
        else if (type === 'answer') {
          const connection = pinConnections.get(pin);
          
          if (!connection) {
            ws.send(JSON.stringify({ 
              error: 'No offer found for this PIN. Please check the PIN.',
              pin 
            }));
            console.log(`[${clientId}] No offer found for PIN: ${pin}`);
            return;
          }

          if (!connection.offerSocket) {
            ws.send(JSON.stringify({ 
              error: 'Sender disconnected. Please get a new PIN.',
              pin 
            }));
            console.log(`[${clientId}] Offer socket unavailable for PIN: ${pin}`);
            pinConnections.delete(pin);
            return;
          }

          // Send answer to the sender
          try {
            connection.offerSocket.send(JSON.stringify(msg));
            console.log(`[${clientId}] Relayed answer for PIN: ${pin} to client [${connection.clientId}]`);
            
            // Send confirmation to receiver
            ws.send(JSON.stringify({ 
              status: 'answer_sent', 
              pin,
              message: 'Connection established! You can now transfer files.'
            }));
            
            // Clean up after successful connection
            setTimeout(() => {
              pinConnections.delete(pin);
              console.log(`[${clientId}] Cleaned up PIN: ${pin}`);
            }, 5000);
            
          } catch (error: any) {
            console.error(`[${clientId}] Error sending answer:`, error.message);
            ws.send(JSON.stringify({ 
              error: 'Failed to relay answer to sender',
              pin 
            }));
          }
        } 
        // Unknown message type
        else {
          ws.send(JSON.stringify({ 
            error: 'Unknown message type',
            received: type
          }));
          console.log(`[${clientId}] Unknown message type: ${type}`);
        }
        
      } catch (error: any) {
        console.error(`[${clientId}] Error processing message:`, error.message);
        ws.send(JSON.stringify({ 
          error: 'Invalid message format',
          details: error.message 
        }));
      }
    },
    
    close(ws) {
      const clientId = ws.data.clientId;
      
      connectedClients.delete(ws);
      
      console.log(`[${clientId}] Client disconnected`);
      console.log(`[INFO] Total clients: ${connectedClients.size}`);
      
      // Clean up any PINs associated with this socket
      let cleanedPins = 0;
      for (const [pin, data] of pinConnections.entries()) {
        if (data.offerSocket === ws) {
          pinConnections.delete(pin);
          cleanedPins++;
        }
      }
      
      if (cleanedPins > 0) {
        console.log(`[${clientId}] Cleaned up ${cleanedPins} PIN(s)`);
      }
    }
  })
  
  .listen(PORT);

console.log('===========================================');
console.log('  WebRTC Signaling Server Started');
console.log('===========================================');
console.log(`  Port: ${PORT}`);
console.log(`  HTTP: http://0.0.0.0:${PORT}`);
console.log(`  WebSocket: ws://0.0.0.0:${PORT}/ws`);
console.log('===========================================');
console.log('  For local network access, use:');
console.log(`  ws://<your-local-ip>:${PORT}/ws`);
console.log('  Example: ws://192.168.1.100:8080/ws');
console.log('===========================================');

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[SHUTDOWN] Shutting down gracefully...');
  
  clearInterval(cleanupInterval);
  
  connectedClients.forEach((client) => {
    try {
      client.send(JSON.stringify({ 
        status: 'server_shutdown',
        message: 'Server is shutting down'
      }));
      client.close();
    } catch (error) {
      // Ignore errors during shutdown
    }
  });
  
  app.stop();
  
  console.log('[SHUTDOWN] Server closed');
  process.exit(0);
}