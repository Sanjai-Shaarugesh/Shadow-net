<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { hub, takeInviteFromHash, buildInviteLink } from '../utils/groups.svelte';
  import { notifySupported, notifyGranted, requestNotifyPermission } from './notify';

  // Route of this page, used when building invite links (change to your route).
  const PAGE = window.location.pathname;

  let newName = $state('');
  let joinInput = $state('');
  let draft = $state('');
  let err = $state('');
  let showInfo = $state(false);
  let copied = $state(false);
  let box: HTMLDivElement | undefined = $state();
  let notifyOn = $state(notifyGranted());
  let editingName = $state(false);
  let nameDraft = $state('');

  const active = $derived(hub.activeGid ? hub.find(hub.activeGid) : undefined);
  const list = $derived(active ? (hub.messages[active.gid] ?? []) : []);
  const inviteLink = $derived(active ? buildInviteLink(hub.inviteCode(active.gid), PAGE) : '');

  onMount(async () => {
    await hub.init();
    const inv = takeInviteFromHash();
    if (inv) joinInput = inv;
  });

  $effect(() => {
    list.length;
    tick().then(() => box?.scrollTo({ top: box.scrollHeight }));
  });

  async function guard(fn: () => Promise<unknown>) {
    err = '';
    try {
      await fn();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }

  const create = () =>
    guard(async () => {
      const g = await hub.createGroup(newName);
      newName = '';
      hub.open(g.gid);
    });

  const join = () =>
    guard(async () => {
      const g = await hub.join(joinInput);
      joinInput = '';
      hub.open(g.gid);
    });

  const send = () =>
    guard(async () => {
      const t = draft;
      draft = '';
      try {
        await hub.send(hub.activeGid!, t);
      } catch (e) {
        draft = t;
        throw e;
      }
    });

  async function copyInvite() {
    await navigator.clipboard?.writeText(inviteLink);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function shareInvite() {
    if (navigator.share)
      await navigator.share({ title: active?.name, url: inviteLink }).catch(() => {});
    else await copyInvite();
  }

  async function enableNotify() {
    notifyOn = await requestNotifyPermission();
  }

  async function leaveOrDelete() {
    if (!active) return;
    const owner = hub.isOwner(active);
    if (!confirm(owner ? 'Delete this group for everyone?' : 'Leave this group?')) return;
    showInfo = false;
    await guard(() => (owner ? hub.deleteForEveryone(active!.gid) : hub.leave(active!.gid)));
  }

  async function remove(id: string, name: string) {
    if (!active || !confirm(`Remove ${name}? The group key will change.`)) return;
    await guard(() => hub.removeMember(active!.gid, id));
  }

  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<div
  class="mx-auto flex h-dvh max-w-2xl flex-col"
  style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);"
>
  {#if !hub.ready}
    <div class="m-auto loading loading-spinner"></div>
  {:else if !active}
    <!-- ============ group list ============ -->
    <header class="flex items-center gap-2 p-3">
      <h1 class="text-lg font-semibold flex-1">Groups</h1>
      {#if editingName}
        <input
          class="input input-sm input-bordered w-36"
          bind:value={nameDraft}
          maxlength="30"
          onkeydown={(e) =>
            e.key === 'Enter' && (hub.setDeviceName(nameDraft), (editingName = false))}
        />
        <button
          class="btn btn-sm btn-primary"
          onclick={() => (hub.setDeviceName(nameDraft), (editingName = false))}>Save</button
        >
      {:else}
        <button
          class="btn btn-sm btn-ghost"
          onclick={() => ((nameDraft = hub.deviceName), (editingName = true))}
        >
          {hub.deviceName}
        </button>
      {/if}
    </header>

    {#if notifySupported() && !notifyOn}
      <div class="alert mx-3 mb-2 py-2 text-sm">
        <span>Get a popup when a message arrives.</span>
        <button class="btn btn-sm btn-primary" onclick={enableNotify}>Turn on</button>
      </div>
    {/if}
    {#if err}<div class="alert alert-error mx-3 mb-2 py-2 text-sm">{err}</div>{/if}

    <ul class="menu flex-1 overflow-y-auto px-2">
      {#each hub.groups as g (g.gid)}
        <li>
          <button class="flex justify-between" onclick={() => hub.open(g.gid)}>
            <span class="truncate">
              <span class="font-medium">{g.name}</span>
              <span class="ml-2 text-xs opacity-60">{Object.keys(g.members).length} members</span>
            </span>
            {#if hub.unread[g.gid]}<span class="badge badge-primary">{hub.unread[g.gid]}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="p-6 text-center text-sm opacity-60">
          No groups yet. Create one or paste an invite below.
        </li>
      {/each}
    </ul>

    <div class="space-y-2 p-3">
      <form class="join w-full" onsubmit={(e) => (e.preventDefault(), create())}>
        <input
          class="input input-bordered join-item flex-1"
          placeholder="New group name"
          bind:value={newName}
          maxlength="40"
        />
        <button class="btn btn-primary join-item" disabled={!newName.trim()}>Create</button>
      </form>
      <form class="join w-full" onsubmit={(e) => (e.preventDefault(), join())}>
        <input
          class="input input-bordered join-item flex-1"
          placeholder="Paste invite link or code"
          bind:value={joinInput}
        />
        <button class="btn join-item" disabled={!joinInput.trim()}>Join</button>
      </form>
    </div>
  {:else}
    <!-- ============ chat ============ -->
    <header class="flex items-center gap-1 border-b border-base-300 p-2">
      <button
        class="btn btn-sm btn-ghost"
        aria-label="Back"
        onclick={() => (hub.open(null), (showInfo = false))}>‹</button
      >
      <button
        class="flex-1 truncate text-left font-semibold"
        onclick={() => (showInfo = !showInfo)}
      >
        {active.name}
        <span class="ml-1 text-xs font-normal opacity-60">
          {Object.keys(active.members).length} members · {Object.keys(active.members).filter(
            (id) => hub.peers[id] === 'open'
          ).length} connected
        </span>
      </button>
      <button class="btn btn-sm btn-ghost" onclick={() => (showInfo = !showInfo)}
        >{showInfo ? 'Close' : 'Info'}</button
      >
    </header>

    {#if err}<div class="alert alert-error m-2 py-2 text-sm">{err}</div>{/if}

    {#if showInfo}
      <div class="flex-1 space-y-4 overflow-y-auto p-3">
        <section>
          <h2 class="mb-1 text-sm font-semibold">Invite</h2>
          <p class="mb-2 text-xs opacity-70">
            Anyone with this link joins as a full member. Share it only with people you trust.
          </p>
          <div class="join w-full">
            <input
              class="input input-bordered input-sm join-item flex-1"
              readonly
              value={inviteLink}
              onfocus={(e) => e.currentTarget.select()}
            />
            <button class="btn btn-sm join-item" onclick={copyInvite}
              >{copied ? 'Copied' : 'Copy'}</button
            >
            <button class="btn btn-sm btn-primary join-item" onclick={shareInvite}>Share</button>
          </div>
        </section>

        <section>
          <h2 class="mb-1 text-sm font-semibold">Members</h2>
          <ul class="divide-y divide-base-300">
            {#each Object.entries(active.members) as [id, m] (id)}
              <li class="flex items-center gap-2 py-2">
                <span
                  class="inline-block size-2 rounded-full {id === hub.deviceId ||
                  hub.peers[id] === 'open'
                    ? 'bg-success'
                    : hub.peers[id] === 'connecting'
                      ? 'bg-warning'
                      : 'bg-base-300'}"
                  title={id === hub.deviceId
                    ? 'This device'
                    : hub.peers[id] === 'open'
                      ? 'Connected'
                      : hub.peers[id] === 'connecting'
                        ? 'Connecting'
                        : 'Offline'}
                ></span>
                <span class="flex-1 truncate">
                  {m.name}
                  {#if id === hub.deviceId}<span class="opacity-60">(you)</span>{/if}
                  {#if id === active.owner}<span class="badge badge-sm ml-1">owner</span>{/if}
                </span>
                {#if hub.isOwner(active) && id !== hub.deviceId}
                  <button class="btn btn-xs btn-ghost text-error" onclick={() => remove(id, m.name)}
                    >Remove</button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        <button class="btn btn-error btn-outline w-full" onclick={leaveOrDelete}>
          {hub.isOwner(active) ? 'Delete group for everyone' : 'Leave group'}
        </button>
      </div>
    {:else}
      <div bind:this={box} class="flex-1 space-y-1 overflow-y-auto p-3">
        {#each list as m (m.id)}
          {#if m.sys}
            <div class="py-1 text-center text-xs opacity-60">{m.text}</div>
          {:else}
            {@const mine = m.from === hub.deviceId}
            <div class="chat {mine ? 'chat-end' : 'chat-start'}">
              {#if !mine}<div class="chat-header text-xs opacity-70">{m.fromName}</div>{/if}
              <div
                class="chat-bubble whitespace-pre-wrap break-words {mine
                  ? 'chat-bubble-primary'
                  : ''}"
              >
                {m.text}
              </div>
              <div class="chat-footer text-xs opacity-60">
                {time(m.ts)}{m.pending ? ' · waiting to send' : ''}
              </div>
            </div>
          {/if}
        {:else}
          <div class="p-6 text-center text-sm opacity-60">No messages yet.</div>
        {/each}
      </div>

      <form class="join w-full p-2" onsubmit={(e) => (e.preventDefault(), send())}>
        <input
          class="input input-bordered join-item flex-1"
          placeholder="Message"
          bind:value={draft}
          maxlength="1500"
          autocomplete="off"
        />
        <button class="btn btn-primary join-item" disabled={!draft.trim()}>Send</button>
      </form>
    {/if}
  {/if}
</div>
