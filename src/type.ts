import type { MetaData } from './proto/message';
import type { EventEmitter } from 'eventemitter3';

export enum FileStatus {
  Pending = 'Pending',
  WaitingAccept = 'WaitingAccept',
  Processing = 'Processing',
  Success = 'Success',
  Error = "Error",
  Receiving = "Receiving"
}

export enum ConnectionStatus {
  Disconnected = 'Disconnected',
  Connecting = 'Connecting',
  Connected = 'Connected',
  Failed = 'Failed'
}

export interface FileDetail {
  fileBlob: any;
  metaData: MetaData;
  progress: number; // percentage
  bitrate: number; // bytes per second
  error?: Error;
  startTime: number;
  status: FileStatus;
  aesKey?: CryptoKey;
}

export interface SendingFile extends FileDetail {
  stop: boolean;
  file: File;
  event?: EventEmitter;
  trackers: string[];
}

export interface ReceivingFile extends FileDetail {
  receivedSize: number;
  receivedChunks: Uint8Array[];
}

export interface SendOptions {
  retryStrategy: any;
  isEncrypt: boolean;
  chunkSize: number;
  iceServer: string;
  wasmBufferSize: number;
  parallelChunks: number;
  useStreaming: boolean;
  compressionLevel: number;
  priorityQueueing: boolean;
  adaptiveChunking: boolean;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
  timeout: number;
  retryAttempts: number;
}

export interface ReceiveOptions {
  shareAfterDownload: boolean;
  autoDownload: any;
  autoAccept: boolean;
  maxSize: number;
  receiverBufferSize: number;
  useStreaming: boolean;
  decompressInBackground: boolean;
  preallocateStorage: boolean;
  progressInterval: number;
  useBinaryMode: boolean;
  prioritizeDownload: boolean;
  chunkTimeout: number;
}

// Enhanced interfaces for global connectivity
export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'connection-request' | 'connection-response' | 'file-metadata' | 'chunk';
  roomId: string;
  peerId: string;
  data: any;
  timestamp: number;
}

export interface PeerConnection {
  id: string;
  connection: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  status: ConnectionStatus;
  lastActivity: number;
}

export interface NetworkInfo {
  type: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  effectiveType: '2g' | '3g' | '4g' | '5g' | 'unknown';
  downlink: number;
  rtt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: 'mobile' | 'desktop' | 'tablet' | 'unknown';
  capabilities: {
    webrtc: boolean;
    datachannel: boolean;
    wasm: boolean;
  };
  network: NetworkInfo;
}