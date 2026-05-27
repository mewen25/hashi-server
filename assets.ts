const ASSETS_BASE_URL = Bun.env.ASSETS_BASE_URL;

export function assetUrl(path: string): string {
  if (!ASSETS_BASE_URL) return path;
  return `${ASSETS_BASE_URL.replace(/\/+$/, '')}/${path}`;
}

export async function assetExists(path: string): Promise<boolean> {
  const url = assetUrl(path);
  if (!ASSETS_BASE_URL) {
    return Bun.file(url).exists();
  }
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function readAsset(path: string): Promise<Uint8Array | null> {
  const url = assetUrl(path);
  if (!ASSETS_BASE_URL) {
    const file = Bun.file(url);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}
