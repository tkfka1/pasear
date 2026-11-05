import { randomBytes } from "node:crypto";

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function authorizationPage(res, { title, body, refresh = false, status = 200 }) {
  const nonce = randomBytes(16).toString("base64");
  // Preserve same-origin POST Origin for CSRF validation without sending referrers to other sites.
  res.set({
    "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  });
  if (refresh) res.set("Refresh", "3");
  return res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · pasear</title><style nonce="${nonce}">
    :root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;margin:0;background:Canvas;color:CanvasText}main{max-width:38rem;margin:3rem auto;padding:0 1.25rem}h1{font-size:1.5rem;line-height:1.4;margin:0 0 1rem}h2{font-size:1rem}p{margin:1rem 0}dl{margin:1.5rem 0}dt{font-weight:600;margin-top:.75rem}dd{margin:.25rem 0;overflow-wrap:anywhere}form{margin:1.5rem 0}label{display:block;font-weight:600;margin-bottom:.5rem}input,button{box-sizing:border-box;min-height:44px;font:inherit;padding:.65rem .8rem}input{width:100%;margin-bottom:1rem}button{cursor:pointer}strong{font-weight:650}[role=alert]{border:1px solid;padding:.75rem}
  </style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
}
