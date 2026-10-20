export interface ShareInput {
  title: string;
  text?: string;
  url?: string;
}

/** Opens the share sheet; falls back to copying the link. Resolves false when nothing could be shared. */
export async function share(input: ShareInput): Promise<boolean> {
  try {
    if (navigator.share) {
      await navigator.share(input);
      return true;
    }
    const text = input.url ?? input.text;
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
  }
  return false;
}
