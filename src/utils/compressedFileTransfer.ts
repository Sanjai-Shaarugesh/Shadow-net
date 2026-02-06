// compressedFileTransfer.ts - Integrated ZPAQ compression with WebRTC file transfer
// Full working implementation

import { throttledSend } from './fileSendHelper';
import ZPAQCompressor, { type CompressionMetadata } from './zpaqCompression';
import { calculateOptimalChunkSize } from './uniqueCode';
import { humanFileSize } from './humanFIleSize';

interface FileMetadata {
  type: 'file_metadata';
  fileName: string;
  originalSize: number;
  compressedSize: number;
  wasCompressed: boolean;
  compressionMetadata: CompressionMetadata | null;
  timestamp: number;
}

/**
 * Compressed file transfer manager
 */
export class CompressedFileTransfer {
  private compressionMetadata: CompressionMetadata | null = null;
  private originalFileName: string = '';

  /**
   * Send file with automatic ZPAQ compression
   */
  async sendFile(
    channel: RTCDataChannel,
    file: File,
    onProgress?: (percent: number, phase: 'compress' | 'transfer') => void
  ): Promise<void> {
    console.log(`Preparing to send: ${file.name} (${humanFileSize(file.size)})`);

    // Read file data
    const fileData = await file.arrayBuffer();
    const chunkSize = calculateOptimalChunkSize(file.size);

    // Compress file
    console.log('Compressing file...');
    const compressionResult = await ZPAQCompressor.compress(fileData, (percent) => {
      onProgress?.(percent / 2, 'compress'); // First 50% is compression
    });

    const { compressed, metadata } = compressionResult;
    const compressedBuffer = compressed.buffer;

    console.log(
      `Compression ${metadata.algorithm}: ${humanFileSize(metadata.originalSize)} → ` +
      `${humanFileSize(metadata.compressedSize)} ` +
      `(${((metadata.originalSize - metadata.compressedSize) / metadata.originalSize * 100).toFixed(1)}% reduction)`
    );

    // Send metadata first
    const fileMetadata: FileMetadata = {
      type: 'file_metadata',
      fileName: file.name,
      originalSize: file.size,
      compressedSize: compressedBuffer.byteLength,
      wasCompressed: metadata.algorithm !== 'none',
      compressionMetadata: metadata,
      timestamp: Date.now()
    };

    channel.send(JSON.stringify(fileMetadata));
    console.log('Sent file metadata');

    // Send compressed data
    console.log('Sending compressed file...');
    await this.throttledSendWithProgress(
      channel,
      compressedBuffer,
      chunkSize,
      (percent) => {
        onProgress?.(50 + percent / 2, 'transfer'); // Second 50% is transfer
      }
    );

    console.log('File transfer complete!');
  }

  /**
   * Receive and decompress file
   */
  async receiveFile(
    data: ArrayBuffer,
    metadata: FileMetadata,
    onProgress?: (percent: number) => void
  ): Promise<ArrayBuffer> {
    if (!metadata.wasCompressed || !metadata.compressionMetadata) {
      console.log('File was not compressed, returning as-is');
      return data;
    }

    console.log(`Decompressing file: ${humanFileSize(data.byteLength)}`);

    const decompressed = await ZPAQCompressor.decompress(
      data,
      metadata.compressionMetadata,
      onProgress
    );

    console.log(`Decompressed to: ${humanFileSize(decompressed.byteLength)}`);

    return decompressed;
  }

  /**
   * Throttled send with progress reporting
   */
  private async throttledSendWithProgress(
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

        // Check buffer
        if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
          channel.onbufferedamountlow = sendNextChunk;
          return;
        }

        // Send chunk
        const end = Math.min(currentPosition + chunkSize, fileSize);
        const chunk = data.slice(currentPosition, end);

        try {
          channel.send(chunk);
          sentChunks++;
          currentPosition = end;

          // Report progress
          if (onProgress) {
            const percent = Math.round((sentChunks / totalChunks) * 100);
            onProgress(percent);
          }

          // Continue or finish
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

  /**
   * Get compression statistics
   */
  getCompressionStats(): {
    originalSize: number;
    compressedSize: number;
    ratio: number;
    bytesSaved: number;
  } | null {
    if (!this.compressionMetadata) return null;

    const { originalSize, compressedSize } = this.compressionMetadata;
    return {
      originalSize,
      compressedSize,
      ratio: ((originalSize - compressedSize) / originalSize) * 100,
      bytesSaved: originalSize - compressedSize
    };
  }
}

/**
 * Helper to download received file
 */
export function downloadFile(data: ArrayBuffer, filename: string): void {
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * File receiver class for managing incoming files
 */
export class FileReceiver {
  private receivedChunks: ArrayBuffer[] = [];
  private fileMetadata: FileMetadata | null = null;

  /**
   * Handle incoming data channel message
   */
  async handleMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data === 'string') {
      // Metadata message
      this.fileMetadata = JSON.parse(event.data) as FileMetadata;
      console.log('Received file metadata:', this.fileMetadata);
      this.receivedChunks = [];
    } else {
      // Data chunk
      this.receivedChunks.push(event.data);

      const totalReceived = this.receivedChunks.reduce(
        (sum, chunk) => sum + chunk.byteLength,
        0
      );

      if (this.fileMetadata && totalReceived >= this.fileMetadata.compressedSize) {
        await this.handleCompleteFile();
      }
    }
  }

  /**
   * Handle complete file reception
   */
  private async handleCompleteFile(): Promise<void> {
    if (!this.fileMetadata) return;

    // Combine chunks
    const totalSize = this.receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of this.receivedChunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    console.log(`Received complete file: ${humanFileSize(totalSize)}`);

    // Decompress if needed
    const transfer = new CompressedFileTransfer();
    const finalData = await transfer.receiveFile(
      combined.buffer,
      this.fileMetadata,
      (percent) => {
        console.log(`Decompressing: ${percent}%`);
      }
    );

    // Download file
    downloadFile(finalData, this.fileMetadata.fileName);
    console.log('File download started');

    // Reset for next file
    this.receivedChunks = [];
    this.fileMetadata = null;
  }
}

export default CompressedFileTransfer;
export type { FileMetadata };