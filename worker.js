// Cloudflare Worker: Anthropic proxy + D1 contacten opslag
// Bindings nodig: DB (D1 database), CONTACTS_TOKEN (secret)

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

    // --- GET /contacts?token=... → alle contacten als JSON of HTML ---
    if (url.pathname === '/contacts' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!env.CONTACTS_TOKEN || token !== env.CONTACTS_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      const { results } = await env.DB.prepare(
        'SELECT * FROM contacts ORDER BY scanned_at DESC'
      ).all();

      const fmt = url.searchParams.get('fmt');
      if (fmt === 'html') {
        return new Response(contactsHtml(results, token), {
          headers: { ...CORS, 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST /contacts → contact opslaan ---
    if (url.pathname === '/contacts' && request.method === 'POST') {
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

    // --- Alles anders: proxy naar Anthropic ---
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'Geen x-api-key header' } }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
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

function contactsHtml(rows, token) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.org)}</td>
      <td>${esc(r.title)}</td>
      <td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td>
      <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
      <td>${r.website ? `<a href="${esc(r.website)}" target="_blank">${esc(r.website)}</a>` : ''}</td>
      <td>${esc(r.scanned_at?.slice(0,10) ?? '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gescande contacten</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;max-width:900px;margin:0 auto;color:#1b1f23;}
  h1{font-size:22px;font-weight:700;margin-bottom:16px;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th{text-align:left;padding:8px 10px;background:#f0ece4;border-bottom:2px solid #e4ddd1;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
  td{padding:8px 10px;border-bottom:1px solid #f0ece4;vertical-align:top;}
  tr:hover td{background:#faf8f4;}
  a{color:#c4501c;text-decoration:none;}
  .count{color:#7a7367;font-size:13px;margin-bottom:12px;}
</style>
</head>
<body>
<h1>Gescande contacten</h1>
<p class="count">${rows.length} contact${rows.length !== 1 ? 'en' : ''}</p>
<table>
  <thead><tr><th>Naam</th><th>Bedrijf</th><th>Functie</th><th>Telefoon</th><th>E-mail</th><th>Website</th><th>Datum</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body>
</html>`;
}
