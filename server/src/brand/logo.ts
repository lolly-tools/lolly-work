export function pickBrandLogoUrl(
  assets: Array<{ type?: string; tags?: string[]; formats?: Array<{ format?: string; url?: string }> }>,
  theme: 'light' | 'dark',
): string | undefined {
  const has = (a: { tags?: string[] }, t: string) => Array.isArray(a.tags) && a.tags.includes(t);
  const logos = assets.filter((a) => a?.type === 'vector' && has(a, 'logo'));
  if (!logos.length) return undefined;
  const horizontal = logos.filter((a) => has(a, 'horizontal'));
  const shaped = horizontal.length ? horizontal : logos;
  const themed = shaped.filter((a) => has(a, theme === 'dark' ? 'on-dark' : 'on-light'));
  const pool = themed.length ? themed : shaped;
  let pick = pool[0];
  if (!pick) return undefined;
  const prefer = theme === 'dark' ? ['white', 'green'] : ['green', 'black'];
  for (const p of prefer) {
    const m = pool.find((a) => has(a, p));
    if (m) {
      pick = m;
      break;
    }
  }
  const fmt = pick.formats?.find((f) => f.format === 'svg') ?? pick.formats?.[0];
  return fmt?.url;
}
