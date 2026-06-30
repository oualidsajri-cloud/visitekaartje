// Cloudflare Worker: Anthropic proxy + D1 contacten opslag
//
// Vereiste secrets (Workers → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  → jouw sk-ant-... sleutel
//   APP_PIN            → zelfgekozen pincode (bijv. "0847")
//   CONTACTS_TOKEN     → wachtwoord voor contactenoverzicht
//
// Vereiste binding (Workers → Settings → Bindings → D1):
//   DB                 → jouw D1 database "visitekaartje"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // --- GET /contacts?token=...&fmt=html → contactenoverzicht ---
    if (url.pathname === '/contacts' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!env.CONTACTS_TOKEN || token !== env.CONTACTS_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      const { results } = await env.DB.prepare(
        'SELECT * FROM contacts ORDER BY scanned_at DESC'
      ).all();

      if (url.searchParams.get('fmt') === 'html') {
        return new Response(contactsHtml(results), {
          headers: { ...CORS, 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
      return new Response(JSON.stringify(results, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST /contacts → contact opslaan ---
    if (url.pathname === '/contacts' && request.method === 'POST') {
      if (!checkPin(request, env)) return unauthorized();
      let body;
      try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      const { name='', org='', title='', phone='', email='', website='' } = body;
      await env.DB.prepare(
        'INSERT INTO contacts (name,org,title,phone,email,website,scanned_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(name, org, title, phone, email, website, new Date().toISOString()).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST / → Anthropic API proxy ---
    if (!checkPin(request, env)) return unauthorized();

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
        'content-type': 'application/json',
      },
      body: request.body,
    });

    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
};

function checkPin(request, env) {
  if (!env.APP_PIN) return true; // geen PIN ingesteld → open (tijdelijk)
  return request.headers.get('x-app-pin') === env.APP_PIN;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: { message: 'Ongeldige pincode' } }), {
    status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function contactsHtml(rows) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${esc(r.name)}</td><td>${esc(r.org)}</td><td>${esc(r.title)}</td>
      <td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td>
      <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
      <td>${r.website ? `<a href="${esc(r.website)}" target="_blank">${esc(r.website)}</a>` : ''}</td>
      <td>${esc((r.scanned_at||'').slice(0,10))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="nl"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gescande contacten</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;max-width:960px;margin:0 auto;color:#1b1f23;}
  h1{font-size:22px;font-weight:700;margin-bottom:4px;}
  .sub{color:#7a7367;font-size:13px;margin-bottom:16px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;padding:8px 10px;background:#f0ece4;border-bottom:2px solid #e4ddd1;font-size:11px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;}
  td{padding:8px 10px;border-bottom:1px solid #f0ece4;vertical-align:top;}
  tr:hover td{background:#faf8f4;}
  a{color:#c4501c;text-decoration:none;}
</style></head><body>
<h1>Gescande contacten</h1>
<p class="sub">${rows.length} contact${rows.length !== 1 ? 'en' : ''}</p>
<table>
  <thead><tr><th>Naam</th><th>Bedrijf</th><th>Functie</th><th>Telefoon</th><th>E-mail</th><th>Website</th><th>Datum</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table></body></html>`;
}
