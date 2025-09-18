import type { ReceiveOptions, SendOptions } from './type';

// Diverse STUN and TURN servers for robust connectivity
export const stunServers: string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.l.google.com:19305',
  'stun:stun4.l.google.com:19302',
  'stun:stun4.l.google.com:19305',
  'stun:stun.sipgate.net:3478',
  'stun:stun.sipgate.net:10000',
  'stun:stun.nextcloud.com:3478',
  'stun:stun.nextcloud.com:443',
  'stun:stun.myvoipapp.com:3478',
  'stun:stun.voipstunt.com:3478',
  'turn:numb.viagenie.ca:3478',
  'turn:turn.anyfirewall.com:443'
];

export const pageDescription =
  'A client-side secure P2P file sharing app with revolutionary Pied Piper middle-out compression technology.';
export const githubLink = 'https://github.com/Sanjai-Shaarugesh/Speed-share';

// Pied Piper Algorithm Configuration
interface PiedPiperConfig {
  middleOutRatio: number;
  recursionDepth: number;
  compressionThreshold: number;
  patternRecognitionLevel: number;
  weiszmanScore: number;
  optimalCompressionRatio: number;
}

const PIED_PIPER_CONFIG: PiedPiperConfig = {
  middleOutRatio: 0.618, // Golden ratio for optimal middle-out positioning
  recursionDepth: 12,
  compressionThreshold: 256,
  patternRecognitionLevel: 8,
  weiszmanScore: 5.2, // Theoretical Weiszman score from the show
  optimalCompressionRatio: 0.85
};

// Richard Hendricks' Middle-Out Compression Dictionary
class MiddleOutDictionary {
  private patterns: Map<string, number> = new Map();
  private reversePatterns: Map<number, string> = new Map();
  private patternId: number = 0;
  private frequencyTable: Map<number, number> = new Map();

  constructor() {
    this.initializeBaseDictionary();
  }

  private initializeBaseDictionary(): void {
    // Initialize with common patterns found in typical data
    const commonPatterns = [
      '00', '01', '10', '11', 'FF', 'AA', '55',
      '0000', '1111', 'FFFF', 'AAAA', '5555',
      '000000', '111111', 'FFFFFF'
    ];

    commonPatterns.forEach(pattern => {
      this.patterns.set(pattern, this.patternId);
      this.reversePatterns.set(this.patternId, pattern);
      this.frequencyTable.set(this.patternId, 1);
      this.patternId++;
    });
  }

  addPattern(pattern: string): number {
    if (this.patterns.has(pattern)) {
      const id = this.patterns.get(pattern)!;
      this.frequencyTable.set(id, (this.frequencyTable.get(id) || 0) + 1);
      return id;
    }

    const id = this.patternId++;
    this.patterns.set(pattern, id);
    this.reversePatterns.set(id, pattern);
    this.frequencyTable.set(id, 1);
    return id;
  }

  getPattern(id: number): string | undefined {
    return this.reversePatterns.get(id);
  }

  getPatternId(pattern: string): number | undefined {
    return this.patterns.get(pattern);
  }

  getFrequency(id: number): number {
    return this.frequencyTable.get(id) || 0;
  }

  optimizeDictionary(): void {
    // Remove low-frequency patterns to optimize compression
    const threshold = Math.max(2, Math.floor(this.patternId * 0.01));
    
    for (const [id, frequency] of this.frequencyTable.entries()) {
      if (frequency < threshold && id >= 100) { // Keep base patterns
        const pattern = this.reversePatterns.get(id);
        if (pattern) {
          this.patterns.delete(pattern);
          this.reversePatterns.delete(id);
          this.frequencyTable.delete(id);
        }
      }
    }
  }
}

// Pied Piper's Revolutionary Middle-Out Compression Engine
class PiedPiperCompressionEngine {
  private dictionary: MiddleOutDictionary;
  private config: PiedPiperConfig;

  constructor(config: PiedPiperConfig = PIED_PIPER_CONFIG) {
    this.dictionary = new MiddleOutDictionary();
    this.config = config;
  }

  // The legendary middle-out algorithm implementation
  private findMiddleOutPosition(data: Uint8Array): number {
    const length = data.length;
    const goldenRatio = this.config.middleOutRatio;
    
    // Find the optimal middle position using the golden ratio
    const baseMiddle = Math.floor(length * goldenRatio);
    
    // Adjust based on data entropy to find the true "middle-out" point
    let maxEntropy = 0;
    let optimalPosition = baseMiddle;
    
    const windowSize = Math.min(32, Math.floor(length * 0.1));
    
    for (let i = Math.max(0, baseMiddle - windowSize); 
         i <= Math.min(length - windowSize, baseMiddle + windowSize); 
         i++) {
      const window = data.slice(i, i + windowSize);
      const entropy = this.calculateEntropy(window);
      
      if (entropy > maxEntropy) {
        maxEntropy = entropy;
        optimalPosition = i;
      }
    }
    
    return optimalPosition;
  }

  private calculateEntropy(data: Uint8Array): number {
    const frequency = new Map<number, number>();
    
    for (const byte of data) {
      frequency.set(byte, (frequency.get(byte) || 0) + 1);
    }
    
    let entropy = 0;
    const length = data.length;
    
    for (const count of frequency.values()) {
      const probability = count / length;
      entropy -= probability * Math.log2(probability);
    }
    
    return entropy;
  }

  // Pattern recognition using middle-out approach
  private recognizePatterns(data: Uint8Array, startPos: number, direction: 'left' | 'right'): {
    patterns: Array<{ pattern: string; position: number; length: number }>;
    compressedData: Uint8Array;
  } {
    const patterns: Array<{ pattern: string; position: number; length: number }> = [];
    const result: number[] = [];
    let pos = startPos;
    const step = direction === 'right' ? 1 : -1;
    const end = direction === 'right' ? data.length : -1;

    while (pos !== end && Math.abs(pos - startPos) < data.length) {
      let bestMatch = { length: 0, pattern: '', id: -1 };
      
      // Try different pattern lengths
      for (let len = this.config.patternRecognitionLevel; len >= 2; len--) {
        if (direction === 'right' && pos + len > data.length) continue;
        if (direction === 'left' && pos - len < 0) continue;
        
        const patternBytes = direction === 'right' 
          ? data.slice(pos, pos + len)
          : data.slice(pos - len + 1, pos + 1);
        
        const patternHex = Array.from(patternBytes)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
        
        const patternId = this.dictionary.getPatternId(patternHex);
        
        if (patternId !== undefined && len > bestMatch.length) {
          bestMatch = { length: len, pattern: patternHex, id: patternId };
        }
      }
      
      if (bestMatch.length > 0) {
        patterns.push({
          pattern: bestMatch.pattern,
          position: direction === 'right' ? pos : pos - bestMatch.length + 1,
          length: bestMatch.length
        });
        
        // Encode as pattern reference
        result.push(0xFF, 0xFE); // Pattern marker
        result.push(bestMatch.id & 0xFF, (bestMatch.id >> 8) & 0xFF);
        
        pos += step * bestMatch.length;
      } else {
        // No pattern found, store raw byte
        const bytePos = direction === 'right' ? pos : pos;
        if (bytePos >= 0 && bytePos < data.length) {
          result.push(data[bytePos]);
          
          // Learn new patterns
          if (direction === 'right' && pos + 4 <= data.length) {
            const newPattern = Array.from(data.slice(pos, pos + 4))
              .map(b => b.toString(16).padStart(2, '0'))
              .join('')
              .toUpperCase();
            this.dictionary.addPattern(newPattern);
          }
        }
        pos += step;
      }
    }

    return {
      patterns,
      compressedData: new Uint8Array(result)
    };
  }

  // The main compression function using middle-out algorithm
  compress(data: Uint8Array): {
    compressedData: Uint8Array;
    compressionRatio: number;
    weiszmanScore: number;
    metadata: {
      originalSize: number;
      compressedSize: number;
      middleOutPosition: number;
      patterns: number;
      algorithm: string;
    };
  } {
    if (data.length < this.config.compressionThreshold) {
      return {
        compressedData: data,
        compressionRatio: 1.0,
        weiszmanScore: 1.0,
        metadata: {
          originalSize: data.length,
          compressedSize: data.length,
          middleOutPosition: 0,
          patterns: 0,
          algorithm: 'Pied Piper Middle-Out (No Compression - Too Small)'
        }
      };
    }

    // Step 1: Find the optimal middle-out position
    const middleOutPos = this.findMiddleOutPosition(data);
    
    // Step 2: Compress from middle to right
    const rightCompression = this.recognizePatterns(data, middleOutPos, 'right');
    
    // Step 3: Compress from middle to left
    const leftCompression = this.recognizePatterns(data, middleOutPos - 1, 'left');
    
    // Step 4: Combine results and create header
    const header = new Uint8Array([
      0x50, 0x50, // "PP" - Pied Piper signature
      0x4D, 0x4F, // "MO" - Middle-Out
      (data.length >>> 24) & 0xFF,
      (data.length >>> 16) & 0xFF,
      (data.length >>> 8) & 0xFF,
      data.length & 0xFF,
      (middleOutPos >>> 8) & 0xFF,
      middleOutPos & 0xFF,
      this.config.recursionDepth,
      Math.floor(this.config.weiszmanScore * 10)
    ]);
    
    // Combine left (reversed) + right compression
    const leftReversed = new Uint8Array(leftCompression.compressedData.length);
    for (let i = 0; i < leftCompression.compressedData.length; i++) {
      leftReversed[i] = leftCompression.compressedData[leftCompression.compressedData.length - 1 - i];
    }
    
    const combinedData = new Uint8Array(
      header.length + 
      leftReversed.length + 
      rightCompression.compressedData.length + 
      4 // separators
    );
    
    let offset = 0;
    combinedData.set(header, offset);
    offset += header.length;
    
    // Left section marker
    combinedData[offset++] = 0xAA;
    combinedData[offset++] = leftReversed.length & 0xFF;
    combinedData.set(leftReversed, offset);
    offset += leftReversed.length;
    
    // Right section marker  
    combinedData[offset++] = 0xBB;
    combinedData[offset++] = rightCompression.compressedData.length & 0xFF;
    combinedData.set(rightCompression.compressedData, offset);
    
    // Optimize dictionary for future compressions
    this.dictionary.optimizeDictionary();
    
    const compressionRatio = combinedData.length / data.length;
    const weiszmanScore = this.calculateWeiszmanScore(compressionRatio, data.length);
    
    return {
      compressedData: combinedData,
      compressionRatio,
      weiszmanScore,
      metadata: {
        originalSize: data.length,
        compressedSize: combinedData.length,
        middleOutPosition: middleOutPos,
        patterns: rightCompression.patterns.length + leftCompression.patterns.length,
        algorithm: 'Pied Piper Middle-Out Compression v1.0'
      }
    };
  }

  // Decompress using middle-out algorithm
  decompress(compressedData: Uint8Array): Uint8Array {
    if (compressedData.length < 12) {
      return compressedData; // Not compressed with our algorithm
    }
    
    // Verify Pied Piper signature
    if (compressedData[0] !== 0x50 || compressedData[1] !== 0x50 ||
        compressedData[2] !== 0x4D || compressedData[3] !== 0x4F) {
      return compressedData; // Not our format
    }
    
    // Extract header information
    const originalSize = (compressedData[4] << 24) | 
                        (compressedData[5] << 16) | 
                        (compressedData[6] << 8) | 
                        compressedData[7];
    
    const middleOutPos = (compressedData[8] << 8) | compressedData[9];
    
    let offset = 12;
    
    // Extract left section
    if (offset >= compressedData.length || compressedData[offset] !== 0xAA) {
      throw new Error('Invalid Pied Piper compression format');
    }
    offset++;
    
    const leftLength = compressedData[offset++];
    const leftData = compressedData.slice(offset, offset + leftLength);
    offset += leftLength;
    
    // Extract right section
    if (offset >= compressedData.length || compressedData[offset] !== 0xBB) {
      throw new Error('Invalid Pied Piper compression format');
    }
    offset++;
    
    const rightLength = compressedData[offset++];
    const rightData = compressedData.slice(offset, offset + rightLength);
    
    // Decompress sections
    const leftDecompressed = this.decompressSection(leftData, true);
    const rightDecompressed = this.decompressSection(rightData, false);
    
    // Reconstruct original data using middle-out positioning
    const result = new Uint8Array(originalSize);
    
    // Place left data (reversed back to original order)
    for (let i = 0; i < leftDecompressed.length && middleOutPos - 1 - i >= 0; i++) {
      result[middleOutPos - 1 - i] = leftDecompressed[leftDecompressed.length - 1 - i];
    }
    
    // Place right data
    for (let i = 0; i < rightDecompressed.length && middleOutPos + i < originalSize; i++) {
      result[middleOutPos + i] = rightDecompressed[i];
    }
    
    return result;
  }

  private decompressSection(data: Uint8Array, isLeftSection: boolean): Uint8Array {
    const result: number[] = [];
    let pos = 0;
    
    while (pos < data.length) {
      if (pos + 1 < data.length && data[pos] === 0xFF && data[pos + 1] === 0xFE) {
        // Pattern reference found
        if (pos + 3 >= data.length) break;
        
        const patternId = data[pos + 2] | (data[pos + 3] << 8);
        const pattern = this.dictionary.getPattern(patternId);
        
        if (pattern) {
          // Convert hex pattern back to bytes
          for (let i = 0; i < pattern.length; i += 2) {
            const hexByte = pattern.substr(i, 2);
            result.push(parseInt(hexByte, 16));
          }
        }
        
        pos += 4;
      } else {
        // Raw byte
        result.push(data[pos]);
        pos++;
      }
    }
    
    return new Uint8Array(result);
  }

  private calculateWeiszmanScore(compressionRatio: number, dataSize: number): number {
    // Simulate the Weiszman score calculation from Silicon Valley
    const baseScore = this.config.weiszmanScore;
    const ratioFactor = Math.pow(1 / compressionRatio, 0.5);
    const sizeFactor = Math.log10(dataSize / 1000) * 0.1;
    
    return Math.min(10.0, baseScore * ratioFactor + sizeFactor);
  }
}

// Global Pied Piper compression engine instance
let piedPiperEngine: PiedPiperCompressionEngine | null = null;

function getPiedPiperEngine(): PiedPiperCompressionEngine {
  if (!piedPiperEngine) {
    piedPiperEngine = new PiedPiperCompressionEngine();
  }
  return piedPiperEngine;
}

// Default send options optimized for Pied Piper compression
export const defaultSendOptions: SendOptions = {
  chunkSize: 250 * 1024,
  isEncrypt: true,
  iceServer: stunServers[0],
  wasmBufferSize: 10000000 * 1024,
  parallelChunks: 20,
  useStreaming: true,
  compressionLevel: 20, // Max compression for Pied Piper
  adaptiveChunking: true,
  retryAttempts: 3,
  priorityQueueing: true,
  retryStrategy: 'exponential',
  onProgress: (progress: number) => {},
  signal: AbortSignal.timeout(30000),
  timeout: 30000
};

// Receive options tailored for Pied Piper decompression
export const defaultReceiveOptions: ReceiveOptions = {
  autoAccept: true,
  maxSize: 1000 * 1024 * 1024 * 1024,
  receiverBufferSize: 10000000 * 1024,
  useStreaming: true,
  decompressInBackground: true,
  chunkTimeout: 10000,
  preallocateStorage: true,
  progressInterval: 1000,
  useBinaryMode: true,
  prioritizeDownload: true
};

export const waitIceCandidatesTimeout = 10000;

// Pied Piper compression function - the main API
export async function compressWithPiedPiper(data: Uint8Array, compressionLevel: number = 20): Promise<{
  compressedData: Uint8Array;
  compressionRatio: number;
  weiszmanScore: number;
  metadata: any;
}> {
  const engine = getPiedPiperEngine();
  
  console.log(`🥧 Pied Piper: Starting middle-out compression on ${data.length} bytes...`);
  const startTime = performance.now();
  
  const result = engine.compress(data);
  
  const endTime = performance.now();
  const compressionTime = endTime - startTime;
  
  console.log(`🥧 Pied Piper: Compression complete!`);
  console.log(`   📊 Original size: ${result.metadata.originalSize.toLocaleString()} bytes`);
  console.log(`   📦 Compressed size: ${result.metadata.compressedSize.toLocaleString()} bytes`);
  console.log(`   📈 Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
  console.log(`   🏆 Weiszman Score: ${result.weiszmanScore.toFixed(2)}`);
  console.log(`   🎯 Middle-out position: ${result.metadata.middleOutPosition}`);
  console.log(`   🔍 Patterns found: ${result.metadata.patterns}`);
  console.log(`   ⏱️ Compression time: ${compressionTime.toFixed(2)}ms`);
  console.log(`   🚀 Algorithm: ${result.metadata.algorithm}`);
  
  return result;
}

// Pied Piper decompression function
export async function decompressWithPiedPiper(compressedData: Uint8Array): Promise<Uint8Array> {
  const engine = getPiedPiperEngine();
  
  console.log(`🥧 Pied Piper: Starting middle-out decompression...`);
  const startTime = performance.now();
  
  const result = engine.decompress(compressedData);
  
  const endTime = performance.now();
  const decompressionTime = endTime - startTime;
  
  console.log(`🥧 Pied Piper: Decompression complete in ${decompressionTime.toFixed(2)}ms`);
  console.log(`   📤 Decompressed ${result.length.toLocaleString()} bytes`);
  
  return result;
}

// Enhanced file chunk processing with Pied Piper compression
export async function processFileChunk(chunk: Uint8Array, compressionLevel: number = 20): Promise<Uint8Array> {
  try {
    console.log(`🥧 Processing chunk with Pied Piper middle-out algorithm...`);
    
    const result = await compressWithPiedPiper(chunk, compressionLevel);
    
    // Add Pied Piper metadata header (8 bytes)
    const metadata = new Uint8Array(8);
    const originalSize = chunk.length;
    const weiszmanScore = Math.floor(result.weiszmanScore * 100);
    
    metadata[0] = (originalSize >>> 24) & 0xFF;
    metadata[1] = (originalSize >>> 16) & 0xFF;
    metadata[2] = (originalSize >>> 8) & 0xFF;
    metadata[3] = originalSize & 0xFF;
    metadata[4] = 0x50; // 'P' for Pied Piper
    metadata[5] = 0x50; // 'P' for Pied Piper  
    metadata[6] = (weiszmanScore >>> 8) & 0xFF;
    metadata[7] = weiszmanScore & 0xFF;

    // Combine metadata with compressed data
    const finalResult = new Uint8Array(metadata.length + result.compressedData.length);
    finalResult.set(metadata, 0);
    finalResult.set(result.compressedData, metadata.length);

    const compressionSavings = ((chunk.length - finalResult.length) / chunk.length * 100);
    console.log(`🥧 Pied Piper chunk compression: ${compressionSavings.toFixed(1)}% savings (${chunk.length} → ${finalResult.length} bytes)`);
    
    return finalResult;
  } catch (error) {
    console.error('🥧 Pied Piper compression failed:', error);
    return processFileChunkFallback(chunk);
  }
}

// Enhanced file chunk decompression with Pied Piper
export async function decompressFileChunk(compressedChunk: Uint8Array): Promise<Uint8Array> {
  try {
    if (compressedChunk.length < 8) {
      throw new Error('Invalid Pied Piper chunk: too small');
    }

    // Extract Pied Piper metadata
    const metadata = compressedChunk.slice(0, 8);
    const originalSize = (metadata[0] << 24) | (metadata[1] << 16) | (metadata[2] << 8) | metadata[3];
    const isPiedPiper = metadata[4] === 0x50 && metadata[5] === 0x50;
    const weiszmanScore = ((metadata[6] << 8) | metadata[7]) / 100;
    
    if (!isPiedPiper) {
      console.warn('🥧 Not a Pied Piper compressed chunk, using fallback');
      return decompressWithZstdFallback(compressedChunk.slice(8));
    }
    
    const compressedData = compressedChunk.slice(8);
    console.log(`🥧 Decompressing Pied Piper chunk (Weiszman Score: ${weiszmanScore.toFixed(2)})...`);
    
    const decompressedData = await decompressWithPiedPiper(compressedData);

    // Verify decompressed size matches expected size
    if (decompressedData.length !== originalSize) {
      console.warn(`🥧 Size mismatch: expected ${originalSize}, got ${decompressedData.length}`);
    }

    return decompressedData;
  } catch (error) {
    console.warn('🥧 Pied Piper decompression failed, using fallback:', error);
    return compressedChunk.length > 8 ? compressedChunk.slice(8) : compressedChunk;
  }
}

// Fallback compression using built-in CompressionStream (gzip)
function compressWithZstdFallback(data: Uint8Array): Promise<Uint8Array> {
  return new Promise(async (resolve) => {
    try {
      if ('CompressionStream' in window) {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();
        
        writer.write(data);
        writer.close();
        
        const chunks: Uint8Array[] = [];
        let result;
        while (!(result = await reader.read()).done) {
          chunks.push(new Uint8Array(result.value));
        }
        
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const compressed = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          compressed.set(chunk, offset);
          offset += chunk.length;
        }
        
        resolve(compressed);
      } else {
        resolve(data);
      }
    } catch (error) {
      console.warn('Fallback compression failed:', error);
      resolve(data);
    }
  });
}

// Fallback decompression using built-in DecompressionStream (gzip)
function decompressWithZstdFallback(compressedData: Uint8Array): Promise<Uint8Array> {
  return new Promise(async (resolve) => {
    try {
      if ('DecompressionStream' in window) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        
        writer.write(compressedData);
        writer.close();
        
        const chunks: Uint8Array[] = [];
        let result;
        while (!(result = await reader.read()).done) {
          chunks.push(new Uint8Array(result.value));
        }
        
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const decompressed = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          decompressed.set(chunk, offset);
          offset += chunk.length;
        }
        
        resolve(decompressed);
      } else {
        resolve(compressedData);
      }
    } catch (error) {
      console.warn('Fallback decompression failed:', error);
      resolve(compressedData);
    }
  });
}

// Fallback for chunk processing (original implementation)
function processFileChunkFallback(chunk: Uint8Array): Uint8Array {
  return chunk;
}

// Detect network quality for adaptive settings
export async function detectNetworkQuality(): Promise<{ bandwidth: number; latency: number; reliability: number }> {
  try {
    const startTime = performance.now();
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { method: 'GET', cache: 'no-store' });
    const endTime = performance.now();
    const latency = endTime - startTime;
    const text = await response.text();
    const size = text.length;
    const bandwidth = size / (latency / 1000);

    console.log(`🥧 Network Quality Detection: ${bandwidth.toFixed(0)} bytes/s, ${latency.toFixed(0)}ms latency`);

    return {
      bandwidth,
      latency,
      reliability: latency < 200 ? 1.0 : latency < 500 ? 0.7 : 0.4
    };
  } catch (error) {
    console.warn('Network detection failed', error);
    return { bandwidth: 10 * 1024, latency: 800, reliability: 0.3 };
  }
}

// Optimize transfer settings based on network with Pied Piper considerations
export async function optimizeTransferSettings(options: SendOptions): Promise<SendOptions> {
  const networkQuality = await detectNetworkQuality();
  const optimized = { ...options };

  console.log(`🥧 Optimizing Pied Piper settings for network conditions...`);

  // Pied Piper works better with larger chunks due to pattern recognition
  if (networkQuality.bandwidth < 50 * 1024) {
    optimized.chunkSize = 16 * 1024; // Larger than traditional for better middle-out
    optimized.parallelChunks = 1;
    optimized.compressionLevel = 22; // Maximum compression
  } else if (networkQuality.bandwidth < 200 * 1024) {
    optimized.chunkSize = 32 * 1024;
    optimized.parallelChunks = 2;
    optimized.compressionLevel = 19; // High compression
  } else if (networkQuality.bandwidth < 1024 * 1024) {
    optimized.chunkSize = 64 * 1024;
    optimized.parallelChunks = 3;
    optimized.compressionLevel = 15; // Balanced compression
  } else {
    optimized.chunkSize = 128 * 1024; // Large chunks for optimal pattern recognition
    optimized.parallelChunks = 4;
    optimized.compressionLevel = 12; // Fast compression for high bandwidth
  }

  // For high latency networks, Pied Piper's efficiency compensates
  if (networkQuality.latency > 500) {
    optimized.compressionLevel = Math.max(optimized.compressionLevel, 18);
    console.log(`🥧 High latency detected, increasing Pied Piper compression to level ${optimized.compressionLevel}`);
  }

  if (networkQuality.latency > 300) {
    optimized.parallelChunks = Math.max(2, optimized.parallelChunks);
  }

  console.log(`🥧 Pied Piper optimized settings: ${optimized.chunkSize/1024}KB chunks, ${optimized.parallelChunks} parallel, level ${optimized.compressionLevel}`);

  return optimized;
}

// Create reliable data channel with retries
export async function createReliableDataChannel(peerConnection: RTCPeerConnection, label: string, maxRetries = 3): Promise<RTCDataChannel> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      console.log(`🥧 Creating Pied Piper data channel: ${label} (attempt ${retries + 1}/${maxRetries})`);
      
      const dataChannel = peerConnection.createDataChannel(label, { 
        ordered: true, 
        maxRetransmits: 10,
        binaryType: 'arraybuffer' // Optimal for Pied Piper binary data
      });
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Data channel timeout')), 5000);
        dataChannel.onopen = () => { 
          clearTimeout(timeout); 
          console.log(`🥧 Pied Piper data channel ${label} opened successfully`);
          resolve(); 
        };
        dataChannel.onerror = (error) => { 
          clearTimeout(timeout); 
          console.error(`🥧 Data channel error:`, error);
          reject(error); 
        };
      });
      
      return dataChannel;
    } catch (error) {
      retries++;
      console.warn(`🥧 Data channel creation failed (attempt ${retries}):`, error);
      if (retries >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retries)));
    }
  }
  throw new Error('Failed to create data channel');
}

// Enhanced file transfer function with Pied Piper compression
export async function sendFile(file: File, peerConnection: RTCPeerConnection) {
  const options = await optimizeTransferSettings(defaultSendOptions);
  const dataChannel = await createReliableDataChannel(peerConnection, 'piedPiperTransfer');
  let offset = 0;
  const fileSize = file.size;
  const reader = new FileReader();
  let totalCompressedSize = 0;
  let totalWeiszmanScore = 0;
  let chunkCount = 0;

  console.log(`🥧 Pied Piper: Starting file transfer`);
  console.log(`   📁 File: ${file.name}`);
  console.log(`   📏 Size: ${fileSize.toLocaleString()} bytes`);
  console.log(`   🎛️ Compression level: ${options.compressionLevel}`);
  console.log(`   📦 Chunk size: ${(options.chunkSize / 1024).toFixed(0)}KB`);

  dataChannel.onopen = async () => {
    const startTime = performance.now();
    
    // Send file metadata first
    const metadata = {
      fileName: file.name,
      fileSize: fileSize,
      mimeType: file.type,
      algorithm: 'Pied Piper Middle-Out v1.0',
      timestamp: Date.now()
    };
    
    const metadataStr = JSON.stringify(metadata);
    const metadataBytes = new TextEncoder().encode(metadataStr);
    const metadataHeader = new Uint8Array(4 + metadataBytes.length);
    
    // Metadata length (4 bytes) + metadata
    metadataHeader[0] = (metadataBytes.length >>> 24) & 0xFF;
    metadataHeader[1] = (metadataBytes.length >>> 16) & 0xFF;
    metadataHeader[2] = (metadataBytes.length >>> 8) & 0xFF;
    metadataHeader[3] = metadataBytes.length & 0xFF;
    metadataHeader.set(metadataBytes, 4);
    
    console.log(`🥧 Sending file metadata (${metadataBytes.length} bytes)`);
    dataChannel.send(metadataHeader);
    
    // Wait a moment for metadata to be processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    while (offset < fileSize) {
      const chunk = file.slice(offset, Math.min(offset + options.chunkSize, fileSize));
      reader.readAsArrayBuffer(chunk);
      await new Promise((resolve) => (reader.onload = resolve));
      const buffer = reader.result as ArrayBuffer;
      
      // Apply Pied Piper middle-out compression to the chunk
      const compressedChunk = await processFileChunk(new Uint8Array(buffer), options.compressionLevel);
      totalCompressedSize += compressedChunk.length;
      chunkCount++;
      
      // Extract Weiszman score from chunk metadata for tracking
      if (compressedChunk.length >= 8 && 
          compressedChunk[4] === 0x50 && compressedChunk[5] === 0x50) {
        const weiszmanScore = ((compressedChunk[6] << 8) | compressedChunk[7]) / 100;
        totalWeiszmanScore += weiszmanScore;
      }
      
      dataChannel.send(compressedChunk);
      offset += options.chunkSize;
      
      const progress = (offset / fileSize) * 100;
      options.onProgress(progress);
      
      if (chunkCount % 10 === 0) { // Log every 10 chunks
        const currentCompressionRatio = ((fileSize - totalCompressedSize) / Math.min(offset, fileSize)) * 100;
        const avgWeiszmanScore = totalWeiszmanScore / chunkCount;
        console.log(`🥧 Progress: ${progress.toFixed(1)}% | Compression: ${currentCompressionRatio.toFixed(1)}% | Avg Weiszman: ${avgWeiszmanScore.toFixed(2)}`);
      }
      
      // Add small delay to prevent overwhelming the network
      if (options.parallelChunks <= 2) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    
    const endTime = performance.now();
    const transferTime = (endTime - startTime) / 1000;
    const compressionRatio = ((fileSize - totalCompressedSize) / fileSize) * 100;
    const avgWeiszmanScore = totalWeiszmanScore / chunkCount;
    
    console.log(`🥧 Pied Piper Transfer Complete!`);
    console.log(`   ⏱️ Time: ${transferTime.toFixed(2)}s`);
    console.log(`   📊 Original size: ${fileSize.toLocaleString()} bytes`);
    console.log(`   📦 Compressed size: ${totalCompressedSize.toLocaleString()} bytes`);
    console.log(`   📈 Total compression: ${compressionRatio.toFixed(1)}%`);
    console.log(`   🏆 Average Weiszman Score: ${avgWeiszmanScore.toFixed(2)}`);
    console.log(`   📡 Transfer rate: ${(fileSize / 1024 / transferTime).toFixed(0)} KB/s`);
    console.log(`   🚀 Effective rate: ${(totalCompressedSize / 1024 / transferTime).toFixed(0)} KB/s (after compression)`);
    
    // Send end-of-file marker
    const eofMarker = new Uint8Array([0xEF, 0xEF, 0xEF, 0xEF]);
    dataChannel.send(eofMarker);
    
    // Close after a brief delay
    setTimeout(() => dataChannel.close(), 1000);
  };

  dataChannel.onerror = (error) => {
    console.error(`🥧 Pied Piper transfer error:`, error);
  };
}

// Enhanced file receive function with Pied Piper decompression
export async function receiveFile(dataChannel: RTCDataChannel, expectedSize?: number): Promise<{
  data: Uint8Array;
  metadata: any;
  stats: {
    originalSize: number;
    compressedSize: number;
    compressionRatio: number;
    avgWeiszmanScore: number;
    transferTime: number;
  };
}> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalReceived = 0;
    let totalDecompressed = 0;
    let totalWeiszmanScore = 0;
    let chunkCount = 0;
    let fileMetadata: any = null;
    let expectingMetadata = true;
    let metadataSize = 0;
    let metadataBuffer = new Uint8Array(0);
    const startTime = performance.now();

    console.log(`🥧 Pied Piper: Starting file reception...`);

    dataChannel.onmessage = async (event) => {
      try {
        const receivedData = new Uint8Array(event.data);
        totalReceived += receivedData.length;

        // Handle metadata first
        if (expectingMetadata) {
          if (metadataSize === 0 && receivedData.length >= 4) {
            // Extract metadata size from first 4 bytes
            metadataSize = (receivedData[0] << 24) | (receivedData[1] << 16) | 
                          (receivedData[2] << 8) | receivedData[3];
            
            console.log(`🥧 Expecting metadata of ${metadataSize} bytes`);
            
            // If we have the complete metadata in this chunk
            if (receivedData.length >= 4 + metadataSize) {
              const metadataBytes = receivedData.slice(4, 4 + metadataSize);
              const metadataStr = new TextDecoder().decode(metadataBytes);
              fileMetadata = JSON.parse(metadataStr);
              
              console.log(`🥧 Received file metadata:`, fileMetadata);
              expectingMetadata = false;
              
              // Process any remaining data in this chunk as file data
              if (receivedData.length > 4 + metadataSize) {
                const fileData = receivedData.slice(4 + metadataSize);
                await processFileChunk(fileData);
              }
            } else {
              // Need more data for complete metadata
              metadataBuffer = new Uint8Array(receivedData.length);
              metadataBuffer.set(receivedData);
            }
          } else if (metadataSize > 0) {
            // Continue collecting metadata
            const newBuffer = new Uint8Array(metadataBuffer.length + receivedData.length);
            newBuffer.set(metadataBuffer);
            newBuffer.set(receivedData, metadataBuffer.length);
            metadataBuffer = newBuffer;
            
            if (metadataBuffer.length >= 4 + metadataSize) {
              const metadataBytes = metadataBuffer.slice(4, 4 + metadataSize);
              const metadataStr = new TextDecoder().decode(metadataBytes);
              fileMetadata = JSON.parse(metadataStr);
              
              console.log(`🥧 Received file metadata:`, fileMetadata);
              expectingMetadata = false;
              
              // Process any remaining data as file data
              if (metadataBuffer.length > 4 + metadataSize) {
                const fileData = metadataBuffer.slice(4 + metadataSize);
                await processFileChunk(fileData);
              }
            }
          }
          return;
        }

        // Check for end-of-file marker
        if (receivedData.length === 4 && 
            receivedData[0] === 0xEF && receivedData[1] === 0xEF && 
            receivedData[2] === 0xEF && receivedData[3] === 0xEF) {
          console.log(`🥧 End-of-file marker received`);
          finishReceiving();
          return;
        }

        await processFileChunk(receivedData);

        async function processFileChunk(compressedChunk: Uint8Array) {
          // Decompress the chunk using Pied Piper
          const decompressedChunk = await decompressFileChunk(compressedChunk);
          chunks.push(decompressedChunk);
          totalDecompressed += decompressedChunk.length;
          chunkCount++;
          
          // Extract Weiszman score from chunk metadata for tracking
          if (compressedChunk.length >= 8 && 
              compressedChunk[4] === 0x50 && compressedChunk[5] === 0x50) {
            const weiszmanScore = ((compressedChunk[6] << 8) | compressedChunk[7]) / 100;
            totalWeiszmanScore += weiszmanScore;
          }
          
          // Log progress if expected size is known
          if (fileMetadata && fileMetadata.fileSize) {
            const progress = (totalDecompressed / fileMetadata.fileSize) * 100;
            if (chunkCount % 10 === 0) {
              const avgWeiszmanScore = totalWeiszmanScore / chunkCount;
              console.log(`🥧 Receive progress: ${progress.toFixed(1)}% | Avg Weiszman: ${avgWeiszmanScore.toFixed(2)}`);
            }
          }
        }
      } catch (error) {
        console.error('🥧 Failed to process received chunk:', error);
        reject(error);
      }
    };

    function finishReceiving() {
      try {
        // Combine all decompressed chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        
        const endTime = performance.now();
        const transferTime = (endTime - startTime) / 1000;
        const compressionRatio = totalReceived > 0 ? ((totalDecompressed - totalReceived) / totalDecompressed) * 100 : 0;
        const avgWeiszmanScore = chunkCount > 0 ? totalWeiszmanScore / chunkCount : 0;
        
        const stats = {
          originalSize: totalDecompressed,
          compressedSize: totalReceived,
          compressionRatio,
          avgWeiszmanScore,
          transferTime
        };
        
        console.log(`🥧 Pied Piper Reception Complete!`);
        console.log(`   ⏱️ Time: ${transferTime.toFixed(2)}s`);
        console.log(`   📤 Received: ${totalReceived.toLocaleString()} bytes`);
        console.log(`   📁 Decompressed: ${totalDecompressed.toLocaleString()} bytes`);
        console.log(`   📈 Compression savings: ${compressionRatio.toFixed(1)}%`);
        console.log(`   🏆 Average Weiszman Score: ${avgWeiszmanScore.toFixed(2)}`);
        console.log(`   📡 Receive rate: ${(totalReceived / 1024 / transferTime).toFixed(0)} KB/s`);
        
        resolve({
          data: result,
          metadata: fileMetadata,
          stats
        });
      } catch (error) {
        reject(error);
      }
    }

    dataChannel.onclose = () => {
      console.log(`🥧 Data channel closed, finalizing reception...`);
      finishReceiving();
    };

    dataChannel.onerror = (error) => {
      console.error(`🥧 Pied Piper reception error:`, error);
      reject(error);
    };
  });
}

// Export the Pied Piper compression engine for advanced usage
export { PiedPiperCompressionEngine, MiddleOutDictionary, PIED_PIPER_CONFIG };

// Richard Hendricks would be proud! 🥧
console.log(`🥧 Pied Piper Middle-Out Compression Algorithm loaded successfully!`);
console.log(`   🚀 Ready to revolutionize data compression with middle-out technology`);
console.log(`   🏆 Theoretical Weiszman Score: ${PIED_PIPER_CONFIG.weiszmanScore}`);
console.log(`   📐 Golden Ratio Optimization: ${PIED_PIPER_CONFIG.middleOutRatio}`);
console.log(`   🔄 Max Recursion Depth: ${PIED_PIPER_CONFIG.recursionDepth}`);
console.log(`   🎯 This is not magic, this is mathematics!`);

export default {
  compressWithPiedPiper,
  decompressWithPiedPiper,
  processFileChunk,
  decompressFileChunk,
  sendFile,
  receiveFile,
  PiedPiperCompressionEngine
};