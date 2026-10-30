<script lang="ts">
  // File card. Before the receiver accepts, it shows a RAW preview built from the real
  // file bytes (thumbnail / first frame / first KB of text / hex dump) plus full metadata.
  // Colours use daisyUI tokens so light and dark both stay readable.
  import { FileStatus, type FileDetail } from '../type';
  import { humanFileSize } from '../utils/humanFIleSize';
  import { hexDump, formatDuration } from '../utils/filePreview';
  import { session } from './session.svelte';
  import { onDestroy } from 'svelte';
  import {
    File as FileIcon,
    FileImage,
    FileVideo,
    FileAudio,
    FileText,
    FileArchive,
    Play,
    TriangleAlert,
    LockKeyhole,
    Loader
  } from '@lucide/svelte';

  type Props = {
    fileDetail: FileDetail;
    isSender: boolean;
    children: () => any;
  };
  const { fileDetail, isSender, children }: Props = $props();

  const key = $derived(fileDetail.metaData.name);
  const entry = $derived(isSender ? session.out[key] : session.inc[key]);
  const info = $derived(entry?.info);
  const preparing = $derived(isSender && entry?.phase === 'preparing');

  // full-quality blob once the transfer is done (receiver) or the local file (sender)
  const fullBlob = $derived<Blob | null>(
    isSender
      ? ((fileDetail as any).file ?? null)
      : fileDetail.status === FileStatus.Success
        ? ((fileDetail as any).fileBlob ?? null)
        : null
  );
  let fullUrl: string | null = $state(null);
  $effect(() => {
    const b = fullBlob;
    const wantFull =
      !!b &&
      (b.type.startsWith('video/') ||
        b.type.startsWith('audio/') ||
        (!isSender && b.type.startsWith('image/')));
    const next = wantFull ? URL.createObjectURL(b!) : null;
    fullUrl = next;
    return () => {
      if (next) URL.revokeObjectURL(next);
    };
  });
  onDestroy(() => {
    if (fullUrl) URL.revokeObjectURL(fullUrl);
  });

  const kind = $derived(info?.kind ?? 'none');
  const Icon = $derived(
    fileDetail.metaData.type?.startsWith('image/')
      ? FileImage
      : fileDetail.metaData.type?.startsWith('video/')
        ? FileVideo
        : fileDetail.metaData.type?.startsWith('audio/')
          ? FileAudio
          : kind === 'text'
            ? FileText
            : /zip|rar|7z|tar|gz/i.test(fileDetail.metaData.name)
              ? FileArchive
              : FileIcon
  );

  const ratio = $derived(
    info && info.codec !== 'none' && info.size > 0
      ? Math.round((1 - info.payloadSize / info.size) * 100)
      : 0
  );
  const risky = $derived(!!info?.sniffed && /executable/i.test(info.sniffed));
  const encrypted = $derived((fileDetail.metaData.key?.length ?? 0) > 0);
  const pct = $derived(
    isNaN(fileDetail.progress) ? 100 : Math.max(0, Math.min(100, fileDetail.progress))
  );
  const hex = $derived(kind === 'hex' && entry?.bytes ? hexDump(entry.bytes) : '');
</script>

<article class="fcard">
  <!-- ======== raw preview ======== -->
  <div class="pv" class:pv-media={kind === 'image' || kind === 'video'}>
    {#if preparing}
      <div class="pv-empty">
        <Loader class="h-6 w-6 animate-spin" /><span>Building preview…</span>
      </div>
    {:else if fullUrl && fileDetail.metaData.type?.startsWith('video/')}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={fullUrl} controls playsinline preload="metadata" class="pv-img"></video>
    {:else if fullUrl && fileDetail.metaData.type?.startsWith('audio/')}
      <div class="pv-empty w-full"><audio src={fullUrl} controls class="w-full"></audio></div>
    {:else if fullUrl && fileDetail.metaData.type?.startsWith('image/')}
      <img src={fullUrl} alt={fileDetail.metaData.name} class="pv-img" />
    {:else if kind === 'image' && entry?.url}
      <img src={entry.url} alt="Preview of {fileDetail.metaData.name}" class="pv-img" />
    {:else if kind === 'video'}
      <div class="relative w-full">
        {#if entry?.url}<img src={entry.url} alt="First frame" class="pv-img" />{:else}<div
            class="pv-empty"
          >
            <FileVideo class="h-8 w-8" />
          </div>{/if}
        <span class="play"><Play class="h-6 w-6" /></span>
        {#if info?.duration}<span class="dur">{formatDuration(info.duration)}</span>{/if}
      </div>
    {:else if kind === 'audio'}
      <div class="pv-empty">
        <FileAudio class="h-8 w-8" /><span>{formatDuration(info?.duration)}</span>
      </div>
    {:else if kind === 'text'}
      <pre class="pv-text">{info?.text}{info?.textTruncated ? '\n…' : ''}</pre>
    {:else if kind === 'hex'}
      <pre class="pv-text pv-hex">{hex}</pre>
    {:else}
      <div class="pv-empty">
        <Icon class="h-8 w-8" /><span>{isSender ? 'No preview' : 'Waiting for preview…'}</span>
      </div>
    {/if}
  </div>
  {#if !preparing && !fullUrl && info}
    <p class="pv-cap">
      {#if kind === 'image'}Thumbnail of the actual image
      {:else if kind === 'video'}First frame of the actual video
      {:else if kind === 'text'}First {info.text?.length ?? 0} characters of the file
      {:else if kind === 'hex'}Raw first {entry?.bytes?.length ?? 0} bytes (hex)
      {:else}No visual preview for this type{/if}
    </p>
  {/if}

  <!-- ======== metadata ======== -->
  <div class="body">
    <p class="name" title={fileDetail.metaData.name}>{fileDetail.metaData.name}</p>

    {#if risky}
      <div class="warn">
        <TriangleAlert class="h-4 w-4 shrink-0" /> This is an executable program. Only accept it from
        someone you trust.
      </div>
    {/if}

    <dl class="meta">
      <dt>Size</dt>
      <dd>
        {humanFileSize(info?.size ?? fileDetail.metaData.size)}
        {#if ratio > 0}
          <span class="opacity-70">→ {humanFileSize(info!.payloadSize)} on the wire</span>
          <span class="badge badge-success badge-soft badge-xs">−{ratio}%</span>
        {/if}
      </dd>

      <dt>Type</dt>
      <dd class="break-all">{fileDetail.metaData.type || 'unknown'}</dd>

      {#if info?.sniffed}
        <dt>Detected</dt>
        <dd>{info.sniffed}</dd>
      {/if}
      {#if info?.width && info?.height}
        <dt>Dimensions</dt>
        <dd>{info.width} × {info.height} px</dd>
      {/if}
      {#if info?.duration}
        <dt>Duration</dt>
        <dd>{formatDuration(info.duration)}</dd>
      {/if}
      {#if info?.lastModified}
        <dt>Modified</dt>
        <dd>{new Date(info.lastModified).toLocaleString()}</dd>
      {/if}
      {#if info && info.codec !== 'none'}
        <dt>Compression</dt>
        <dd>deflate (auto-unpacked on save)</dd>
      {/if}
      <dt>Security</dt>
      <dd class="inline-flex items-center gap-1">
        {#if encrypted}<LockKeyhole class="h-3.5 w-3.5" /> AES-GCM end-to-end{:else}DTLS transport
          only{/if}
      </dd>
    </dl>

    <!-- status -->
    <div class="mt-3">
      {#if fileDetail.error}
        <span class="badge badge-error badge-soft gap-1"
          ><TriangleAlert class="h-3.5 w-3.5" /> {fileDetail.error.message}</span
        >
      {:else if preparing}
        <span class="badge badge-info badge-soft gap-1"
          ><span class="loading loading-spinner loading-xs"></span> Preparing</span
        >
      {:else if fileDetail.status === FileStatus.Processing}
        <span class="badge badge-info badge-soft gap-1">
          <span class="loading loading-spinner loading-xs"></span>
          {isSender ? 'Sending' : 'Receiving'} · {humanFileSize(fileDetail.bitrate)}/s
        </span>
      {:else if fileDetail.status === FileStatus.WaitingAccept}
        <span class="badge badge-warning badge-soft"
          >{isSender ? 'Waiting for receiver to accept' : 'Waiting for your decision'}</span
        >
      {:else if fileDetail.status === FileStatus.Success}
        <span class="badge badge-success badge-soft">Done</span>
      {:else}
        <span class="badge badge-ghost">Pending</span>
      {/if}
    </div>

    <div class="mt-2">
      <div class="mb-1 flex justify-between text-xs opacity-70">
        <span>Progress</span><span>{Math.round(pct)}%</span>
      </div>
      <progress class="progress progress-primary w-full" value={pct} max="100"></progress>
    </div>

    <div class="mt-3 flex w-full justify-end">
      {@render children?.()}
    </div>
  </div>
</article>

<style>
  .fcard {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    border-radius: 0.9rem;
    background: var(--color-base-100, #fff);
    color: var(--color-base-content, inherit);
    border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  .pv {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 6rem;
    max-height: 16rem;
    overflow: hidden;
    background: color-mix(
      in oklab,
      var(--color-base-content, #000) 7%,
      var(--color-base-100, #fff)
    );
  }
  .pv-media {
    background: #000;
  }
  .pv-img {
    display: block;
    width: 100%;
    max-height: 16rem;
    object-fit: contain;
  }
  .pv-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 1.25rem;
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .pv-text {
    width: 100%;
    max-height: 16rem;
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    font:
      0.72rem/1.4 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    align-self: stretch;
  }
  .pv-hex {
    white-space: pre;
    overflow-wrap: normal;
    font-size: 0.65rem;
  }
  .pv-cap {
    margin: 0;
    padding: 0.25rem 0.75rem;
    font-size: 0.68rem;
    opacity: 0.6;
    border-bottom: 1px solid color-mix(in oklab, currentColor 10%, transparent);
  }
  .play,
  .dur {
    position: absolute;
    color: #fff;
    background: rgb(0 0 0 / 0.55);
  }
  .play {
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    border-radius: 9999px;
  }
  .dur {
    right: 0.5rem;
    bottom: 0.5rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.35rem;
    font-size: 0.7rem;
  }
  .body {
    padding: 0.75rem 0.85rem 0.85rem;
  }
  .name {
    margin: 0 0 0.35rem;
    font-weight: 600;
    font-size: 0.95rem;
    overflow-wrap: anywhere;
  }
  .warn {
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
    margin: 0.25rem 0 0.5rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.5rem;
    font-size: 0.75rem;
    background: color-mix(in oklab, var(--color-warning, #f5a524) 22%, transparent);
  }
  .meta {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.2rem 0.75rem;
    margin: 0;
    font-size: 0.78rem;
  }
  .meta dt {
    opacity: 0.6;
  }
  .meta dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
