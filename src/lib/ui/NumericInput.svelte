<script lang="ts">
  export let value = 0;
  export let min: number | undefined = undefined;
  export let max: number | undefined = undefined;
  export let step: number | string = 'any';
  export let onCommit: (value: number) => void = () => {};
  export let commitOnInput = true;

  let draft = String(value);
  let focused = false;

  $: if (!focused) {
    draft = String(value);
  }

  function handleInput(event: Event) {
    draft = (event.currentTarget as HTMLInputElement).value;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return;
    if (commitOnInput) onCommit(clamp(parsed));
  }

  function handleFocus() {
    focused = true;
  }

  function handleBlur() {
    focused = false;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed);
      onCommit(next);
      draft = String(next);
    } else {
      draft = String(value);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      (event.currentTarget as HTMLInputElement).blur();
    }
  }

  function clamp(value: number): number {
    let next = value;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  }
</script>

<input
  type="number"
  {min}
  {max}
  {step}
  value={draft}
  onfocus={handleFocus}
  oninput={handleInput}
  onblur={handleBlur}
  onkeydown={handleKeydown}
/>
