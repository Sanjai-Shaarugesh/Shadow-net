<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    isOpen?: boolean;
    children: Snippet;
    toggleable?: boolean;
  };

  let { title, isOpen = $bindable(false), children, toggleable = true }: Props = $props();

  let root: HTMLElement | undefined = $state();
  let wasOpen = isOpen;

  function toggle() {
    if (toggleable) isOpen = !isOpen;
  }

  // When a section opens (by click OR because the parent opened it after a step finished),
  // bring it into view so it is never left under the sticky navbar / on-screen keyboard.
  $effect(() => {
    const open = isOpen;
    if (open && !wasOpen) {
      tick().then(() => root?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    wasOpen = open;
  });
</script>

<!-- No overflow-hidden on the card: dropdowns / selects inside an open section may overlap
     what is below instead of being clipped. The slide transition only clips while animating. -->
<section
  bind:this={root}
  class="collapse-card relative mb-3 min-w-0 rounded-2xl border border-base-300 bg-base-100 shadow-sm transition-shadow duration-200 hover:shadow-md"
>
  <button
    type="button"
    onclick={toggle}
    disabled={!toggleable}
    aria-expanded={isOpen}
    class="flex min-h-12 w-full touch-manipulation items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary md:px-6
           {isOpen
      ? 'rounded-t-2xl bg-primary/10 hover:bg-primary/20'
      : 'rounded-2xl bg-base-200 hover:bg-base-300'}
           {!toggleable ? 'cursor-default opacity-75' : 'cursor-pointer'}"
  >
    <h3
      class="min-w-0 flex-1 truncate text-sm font-medium sm:text-base md:text-lg {isOpen
        ? 'text-primary'
        : 'text-base-content'}"
    >
      {title}
    </h3>

    {#if toggleable}
      <svg
        class="h-5 w-5 shrink-0 transition-transform duration-300 {isOpen
          ? 'rotate-180 text-primary'
          : 'text-base-content/60'}"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    {/if}
  </button>

  {#if isOpen}
    <div
      transition:slide={{ duration: 250, easing: quintOut }}
      class="rounded-b-2xl border-t border-base-300 bg-base-100"
    >
      <div
        class="min-w-0 break-words px-4 py-4 text-sm leading-relaxed text-base-content/90 sm:text-base md:px-6"
      >
        {@render children?.()}
      </div>
    </div>
  {/if}
</section>

<style>
  .collapse-card {
    /* leave room for the sticky/safe-area navbar when scrolled into view */
    scroll-margin-top: calc(4.5rem + env(safe-area-inset-top, 0px));
    scroll-margin-bottom: 1rem;
  }
</style>
