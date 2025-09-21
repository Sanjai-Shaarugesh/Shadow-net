export function humanFileSize(size: number | bigint): string {
  let bytes = BigInt(size);
  if (bytes <= 0n) return '0 B';

  const postfixes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let i = 0;
  let divisor = 1n;

  while (bytes / divisor >= 1024n && i < postfixes.length - 1) {
    divisor *= 1024n;
    i++;
  }

  const num = bytes / divisor;
  const remainder = bytes % divisor;
  const decimal = (remainder * 100n) / divisor;
  const fracStr = decimal.toString().padStart(2, '0').slice(0, 2);

  return `${num}.${fracStr} ${postfixes[i]}`;
}