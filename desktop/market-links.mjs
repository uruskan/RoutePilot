/** Only user-clicked Spansh station links may leave the sandboxed renderer. */
export async function openMarketSource(target, openExternal) {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.hostname !== 'spansh.co.uk' || url.port ||
      url.username || url.password || url.search || url.hash || !/^\/station\/[1-9]\d*$/.test(url.pathname)) return false;
    await openExternal(url.href);
    return true;
  } catch { return false; }
}
