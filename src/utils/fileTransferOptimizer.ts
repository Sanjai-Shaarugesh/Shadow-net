// fileTransferOptimizer.ts - Updated with ZPAQ compression integration
import { calculateOptimalChunkSize } from './uniqueCode';
import { createOptimizedDataChannel, getOptimizedRTCConfiguration } from './crypto';
import ZPAQCompressor, { type CompressionMetadata } from './zpaqCompression';
import { humanFileSize } from './humanFIleSize';

/**
 * File transfer optimizer with ZPAQ compression
 */
export class OptimizedFileTransfer {
  /**
   * Compress and prepare file for transfer
   */
  static async compressFile(
    data: ArrayBuffer,
    onProgress?: (percent: number) => void
  ): Promise<{
    compressed: Uint8Array;
    metadata: CompressionMetadata;
    wasCompressed: boolean;
  }> {
    const result = await ZPAQCompressor.compress(data, onProgress);
    
    return {
      compressed: result.compressed,
      metadata: result.metadata,
      wasCompressed: result.algorithm !== 'none'
    };
  }

  /**
   * Decompress received file
   */
  static async decompressFile(
    data: ArrayBuffer | Uint8Array,
    metadata: CompressionMetadata,
    onProgress?: (percent: number) => void
  ): Promise<ArrayBuffer> {
    if (metadata.algorithm === 'none') {
      return data instanceof Uint8Array ? data.buffer : data;
    }
    
    return await ZPAQCompressor.decompress(data, metadata, onProgress);
  }

  /**
   * Optimized file transfer with compression
   */
  static async transferFileOptimized(
    connection: RTCPeerConnection,
    channel: RTCDataChannel,
    file: File,
    onProgress?: (percent: number, phase: 'compress' | 'transfer') => void
  ): Promise<void> {
    console.log(`Starting optimized transfer: ${file.name} (${humanFileSize(file.size)})`);

    // Step 1: Read file
    const fileData = await file.arrayBuffer();

    // Step 2: Compress file
    console.log('Compressing file with ZPAQ algorithm...');
    const startCompress = performance.now();
    
    const compressionResult = await this.compressFile(fileData, (percent) => {
      onProgress?.(percent / 2, 'compress');
    });

    const compressTime = ((performance.now() - startCompress) / 1000).toFixed(2);
    console.log(
      `Compressed in ${compressTime}s: ` +
      `${humanFileSize(compressionResult.metadata.originalSize)} → ` +
      `${humanFileSize(compressionResult.metadata.compressedSize)} ` +
      `(${((compressionResult.metadata.originalSize - compressionResult.metadata.compressedSize) / 
         compressionResult.metadata.originalSize * 100).toFixed(1)}% reduction)`
    );

    // Step 3: Send metadata
    const metadata = {
      type: 'file_metadata',
      fileName: file.name,
      originalSize: file.size,
      compressedSize: compressionResult.compressed.byteLength,
      wasCompressed: compressionResult.wasCompressed,
      compressionMetadata: compressionResult.metadata,
      timestamp: Date.now()
    };

    channel.send(JSON.stringify(metadata));

    // Step 4: Send compressed data
    console.log('Transferring compressed file...');
    const startTransfer = performance.now();
    
    await this.throttledSend(
      channel,
      compressionResult.compressed.buffer,
      calculateOptimalChunkSize(compressionResult.compressed.byteLength),
      (percent) => {
        onProgress?.(50 + percent / 2, 'transfer');
      }
    );

    const transferTime = ((performance.now() - startTransfer) / 1000).toFixed(2);
    const totalTime = ((performance.now() - startCompress) / 1000).toFixed(2);
    const throughput = (compressionResult.compressed.byteLength / parseFloat(transferTime)) / (1024 * 1024);

    console.log(
      `Transfer complete in ${transferTime}s (total ${totalTime}s, ` +
      `${throughput.toFixed(2)} MB/s)`
    );
  }

  /**
   * Throttled send with progress
   */
  private static async throttledSend(
    channel: RTCDataChannel,
    data: ArrayBuffer,
    chunkSize: number,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fileSize = data.byteLength;
      const totalChunks = Math.ceil(fileSize / chunkSize);
      let sentChunks = 0;
      let currentPosition = 0;

      const sendNextChunk = () => {
        if (currentPosition >= fileSize) {
          resolve();
          return;
        }

        if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
          channel.onbufferedamountlow = sendNextChunk;
          return;
        }

        const end = Math.min(currentPosition + chunkSize, fileSize);
        const chunk = data.slice(currentPosition, end);

        try {
          channel.send(chunk);
          sentChunks++;
          currentPosition = end;

          if (onProgress) {
            onProgress(Math.round((sentChunks / totalChunks) * 100));
          }

          if (currentPosition >= fileSize) {
            channel.onbufferedamountlow = null;
            resolve();
          } else {
            setTimeout(sendNextChunk, 0);
          }
        } catch (error) {
          channel.onbufferedamountlow = null;
          reject(error);
        }
      };

      sendNextChunk();
    });
  }
}

/**
 * File receiver with decompression
 */
export class OptimizedFileReceiver {
  private receivedChunks: ArrayBuffer[] = [];
  private fileMetadata: any = null;
  private onComplete?: (data: ArrayBuffer, filename: string) => void;

  constructor(onComplete?: (data: ArrayBuffer, filename: string) => void) {
    this.onComplete = onComplete;
  }

  async handleMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data === 'string') {
      this.fileMetadata = JSON.parse(event.data);
      console.log('Received metadata:', this.fileMetadata.fileName);
      this.receivedChunks = [];
    } else {
      this.receivedChunks.push(event.data);

      const received = this.receivedChunks.reduce((s, c) => s + c.byteLength, 0);
      const progress = (received / this.fileMetadata.compressedSize) * 100;
      
      if (progress % 10 < 1) {
        console.log(`Received: ${progress.toFixed(0)}%`);
      }

      if (received >= this.fileMetadata.compressedSize) {
        await this.handleComplete();
      }
    }
  }

  private async handleComplete(): Promise<void> {
    console.log('File reception complete, decompressing...');

    // Combine chunks
    const total = this.receivedChunks.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of this.receivedChunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    // Decompress if needed
    let finalData = combined.buffer;

    if (this.fileMetadata.wasCompressed && this.fileMetadata.compressionMetadata) {
      finalData = await OptimizedFileTransfer.decompressFile(
        combined.buffer,
        this.fileMetadata.compressionMetadata,
        (percent) => {
          if (percent % 20 === 0) {
            console.log(`Decompressing: ${percent}%`);
          }
        }
      );
    }

    console.log(`Final file size: ${humanFileSize(finalData.byteLength)}`);

    // Trigger callback
    if (this.onComplete) {
      this.onComplete(finalData, this.fileMetadata.fileName);
    }

    // Reset
    this.receivedChunks = [];
    this.fileMetadata = null;
  }
}

// Legacy compatibility - export original functions
export { calculateOptimalChunkSize } from './uniqueCode';
export { createOptimizedDataChannel, getOptimizedRTCConfiguration } from './crypto';