// posting-identity.mjs — "is this browser tab the tab for THIS posting?"
//
// Three places in the chain had to answer that and each answered it with a
// different, coarser thing: prime_page.mjs compared the registrable domain,
// close_tabs.sh compared the host (migrated here 2026-08-29, after it destroyed
// another six forms), readback.mjs compared the path with the query stripped. On most portals all three happen to work, because the posting
// id is in the path.
//
// On an EMBEDDED Greenhouse form it is not. Every posting on every board is:
//
//   job-boards.greenhouse.io/embed/job_app?for={org}&token={id}
//
// Same host, same path, every time — the posting id lives only in the query. So
// "a tab on greenhouse.io" matched a DIFFERENT posting's tab, and prime_page
// navigated it to the new URL. On the 2026-08-26 batch that destroyed six
// filled forms: impact.com and Ennoble Care were read back as "no open tab",
// and the four before them were silently overwritten mid-batch by the posting
// that followed.
//
// So identity is computed once, here, and the callers share it.
//
// postingKey(url) returns a stable string for the posting, or '' when the URL
// carries nothing identifying (in which case a caller should fall back to
// host+path rather than treating '' as a match — '' === '' must never mean
// "same posting").

const stripWww = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

export function postingKey(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return ''; }
  const host = stripWww(u.host);
  const q = u.searchParams;

  // Greenhouse. The embed form carries `token`; a board posting carries the id
  // in the path; an employer's own page links it as `gh_jid`. All three are the
  // same posting and must produce the same key, because a run can legitimately
  // move between them.
  if (/greenhouse\.io$/.test(host) || q.get('gh_jid') || q.get('token')) {
    const id = q.get('token') || q.get('gh_jid')
      || (u.pathname.match(/\/jobs\/(\d+)/) || [])[1];
    if (id) return `greenhouse:${id}`;
  }

  // Ashby and Lever both key on a uuid in the path, and both append optional
  // trailing segments (/application, /apply) that must not change identity.
  if (/ashbyhq\.com$/.test(host)) {
    const id = q.get('ashby_jid')
      || (u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    if (id) return `ashby:${id.toLowerCase()}`;
  }
  if (/lever\.co$/.test(host)) {
    const id = (u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    if (id) return `lever:${id.toLowerCase()}`;
  }

  // Everything else: host plus path, with the apply/application suffix and any
  // trailing slash normalised away. A wizard portal walks through many URLs
  // under one host, so this is a weak key by design — callers treat a host
  // match as the fallback, not as proof.
  const p = u.pathname.replace(/\/(apply|application)\/?$/i, '').replace(/\/+$/, '');
  return p && p !== '/' ? `url:${host}${p}` : '';
}

// True only when both URLs identify the SAME posting. An unidentifiable URL
// never matches anything, including another unidentifiable one.
export function samePosting(a, b) {
  const ka = postingKey(a);
  return !!ka && ka === postingKey(b);
}

export const hostOf = (raw) => { try { return stripWww(new URL(String(raw)).host); } catch { return ''; } };
