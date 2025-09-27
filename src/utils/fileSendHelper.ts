// fileTransferOptimizer.ts
import { calculateOptimalChunkSize } from './uniqueCode';
import { createOptimizedDataChannel, getOptimizedRTCConfiguration } from './crypto';

/**
 * Configures a WebRTC connection for optimal large file transfer
 * @param connection The RTCPeerConnection to optimize
 * @param fileSize Size of the file to transfer
 * @returns The optimized connection
 */
export function optimizeConnectionForLargeFile(
  connection: RTCPeerConnection,
  fileSize: number
): RTCPeerConnection {
  // Apply optimized configuration
  const config = getOptimizedRTCConfiguration();

  // Apply configurations to existing connection
  if (fileSize > 1024 * 1024 * 1024) {
    // > 1GB
    // Increase buffer sizes for high throughput
    // @ts-ignore - These properties exist but might not be in TypeScript defs
    connection.sctp = connection.sctp || {};
    // @ts-ignore
    connection.sctp.maxMessageSize = 262144; // 256KB max message size
    // @ts-ignore
    connection.sctp.sendBufferSize = calculateOptimalChunkSize(fileSize) * 2;
  }

  return connection;
}

/**
 * Creates a data channel optimized for specific file size
 * @param connection RTCPeerConnection to create channel on
 * @param label Channel label
 * @param fileSize Size of file to transfer
 * @returns Optimized data channel
 */
export function createOptimizedFileChannel(
  connection: RTCPeerConnection,
  label: string,
  fileSize: number
): RTCDataChannel {
  const channelOptions: RTCDataChannelInit = {
    ordered: fileSize < 100 * 1024 * 1024, // Only use ordered for files <100MB
    maxRetransmits: fileSize > 1024 * 1024 * 1024 ? 0 : 3 // No retransmits for large files
  };

  const channel = connection.createDataChannel(label, channelOptions);

  // Set buffer size based on file size
  if (fileSize > 1024 * 1024 * 1024) {
    // > 1GB
    channel.bufferedAmountLowThreshold = calculateOptimalChunkSize(fileSize);
  } else {
    channel.bufferedAmountLowThreshold = 16 * 1024 * 1024; // 16MB for smaller files
  }

  return channel;
}

/**
 * Throttles sending to prevent buffer overflow while maintaining high speed
 * @param channel Data channel to send through
 * @param data Data to send
 * @param chunkSize Size of each chunk
 * @returns Promise that resolves when sending is complete
 */
export async function throttledSend(
  channel: RTCDataChannel,
  data: ArrayBuffer,
  chunkSize: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fileSize = data.byteLength;
    const chunks = Math.ceil(fileSize / chunkSize);
    let sentChunks = 0;
    let currentPosition = 0;

    const sendNextChunk = () => {
      if (currentPosition >= fileSize) {
        resolve();
        return;
      }

      // Check if channel buffer is getting full
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        // Wait for buffer to clear before sending more
        channel.onbufferedamountlow = sendNextChunk;
        return;
      }

      // Send next chunk
      const end = Math.min(currentPosition + chunkSize, fileSize);
      const chunk = data.slice(currentPosition, end);
      try {
        channel.send(chunk);
        sentChunks++;

        // Log progress for large files
        if (fileSize > 100 * 1024 * 1024 && sentChunks % 10 === 0) {
          // console.log(
          //   `Sent ${sentChunks}/${chunks} chunks (${Math.round((currentPosition * 100) / fileSize)}%)`
          // );
        }

        currentPosition = end;

        // Remove event handler if we don't need it anymore
        if (currentPosition >= fileSize) {
          channel.onbufferedamountlow = null;
          resolve();
        } else {
          // Schedule next chunk (use setTimeout to avoid call stack overflow)
          setTimeout(sendNextChunk, 0);
        }
      } catch (error) {
        channel.onbufferedamountlow = null;
        reject(error);
      }
    };

    // Start sending chunks
    sendNextChunk();
  });
}

/**
 * Optimizes file streaming based on available network conditions
 * @param connection RTCPeerConnection to measure
 * @param fileSize Size of file to transfer
 * @returns Optimal chunk size for current network
 */
export async function measureNetworkAndOptimizeChunkSize(
  connection: RTCPeerConnection,
  fileSize: number
): Promise<number> {
  // Start with calculated optimal chunk size
  let optimizedChunkSize = calculateOptimalChunkSize(fileSize);

  try {
    // Create test data channel
    const testChannel = connection.createDataChannel('networkTest', {
      ordered: false,
      maxRetransmits: 0
    });

    // Create a test buffer (1MB)
    const testData = new ArrayBuffer(1024 * 1024);
    const testView = new Uint8Array(testData);
    for (let i = 0; i < testView.length; i++) {
      testView[i] = Math.floor(Math.random() * 256);
    }

    // Measure how quickly we can send 1MB
    const startTime = performance.now();

    await new Promise<void>((resolve, reject) => {
      testChannel.onopen = async () => {
        try {
          testChannel.send(testData);
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      // Set timeout for measurement
      setTimeout(() => resolve(), 3000);
    });

    // Close test channel
    testChannel.close();

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Calculate throughput in MB/s
    const throughput = 1 / (duration / 1000);
    // console.log(`Network throughput: ${throughput.toFixed(2)} MB/s`);

    // Adjust chunk size based on throughput
    if (throughput > 50) {
      // Very fast connection (>50MB/s)
      optimizedChunkSize = Math.min(128 * 1024 * 1024, optimizedChunkSize * 2);
    } else if (throughput < 5) {
      // Slow connection (<5MB/s)
      optimizedChunkSize = Math.max(1 * 1024 * 1024, optimizedChunkSize / 2);
    }

    // console.log(`Optimized chunk size: ${optimizedChunkSize / (1024 * 1024)}MB`);
  } catch (error) {
    console.warn('Error measuring network speed, using default chunk size', error);
  }

  return optimizedChunkSize;
}

/**
 * Manages progressive file transfer with progress tracking
 * @param sender Function that sends a chunk
 * @param data Complete file data
 * @param chunkSize Size of each chunk
 * @param onProgress Progress callback
 * @returns Promise that resolves when transfer is complete
 */
export async function progressiveFileTransfer(
  sender: (chunk: ArrayBuffer, isLast: boolean) => Promise<void>,
  data: ArrayBuffer,
  chunkSize: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  const fileSize = data.byteLength;
  let offset = 0;
  let lastReportedProgress = 0;

  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize, fileSize);
    const chunk = data.slice(offset, end);
    const isLastChunk = end === fileSize;

    // Send this chunk
    await sender(chunk, isLastChunk);

    // Update offset
    offset = end;

    // Report progress if callback provided (throttle to max 100 updates)
    const currentProgress = Math.floor((offset / fileSize) * 100);
    if (onProgress && (currentProgress >= lastReportedProgress + 1 || isLastChunk)) {
      onProgress(currentProgress);
      lastReportedProgress = currentProgress;
    }
  }
}
