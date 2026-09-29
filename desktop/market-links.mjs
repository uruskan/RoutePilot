/** Only user-clicked market sources and the specific system-access guide may open. */
export async function openMarketSource(target, openExternal) {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return false;
    const station = url.hostname === 'spansh.co.uk' && /^\/station\/[1-9]\d*$/.test(url.pathname);
    const accessGuide = url.hostname === 'pilotstradenetwork.com' && url.pathname === '/booze-cruise/';
    if (!station && !accessGuide) return false;
    await openExternal(url.href);
    return true;
  } catch { return false; }
}
