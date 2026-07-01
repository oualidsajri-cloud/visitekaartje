// Cloudflare Worker — Anthropic proxy + D1 contacten opslag

//
// Vereiste secrets (Workers â†’ Settings â†’ Variables and Secrets):
//   ANTHROPIC_API_KEY  â†’ jouw sk-ant-... sleutel
//   APP_PIN            â†’ zelfgekozen pincode (bijv. "0847")
//   CONTACTS_TOKEN     â†’ wachtwoord voor contactenoverzicht
//
// Vereiste binding (Workers â†’ Settings â†’ Bindings â†’ D1):
//   DB                 â†’ jouw D1 database "visitekaartje"

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

    // --- GET /contacts â†’ inlogscherm of contactenoverzicht ---
    if (url.pathname === '/contacts' && request.method === 'GET') {
      return new Response(loginHtml(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // --- POST /contacts/login â†’ token controleren, contacten tonen ---
    if (url.pathname === '/contacts/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      if (!env.CONTACTS_TOKEN || body.token !== env.CONTACTS_TOKEN) {
        return new Response(JSON.stringify({ error: 'Ongeldig wachtwoord' }), {
          status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
      const { results } = await env.DB.prepare(
        'SELECT * FROM contacts ORDER BY scanned_at DESC'
      ).all();
      return new Response(JSON.stringify(results), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST /contacts/check â†’ duplicaten zoeken ---
    if (url.pathname === '/contacts/check' && request.method === 'POST') {
      if (!checkPin(request, env)) return unauthorized();
      let body;
      try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      const { name='', phone='', email='' } = body;
      const { results } = await env.DB.prepare(`
        SELECT * FROM contacts WHERE
          (LOWER(TRIM(name)) = LOWER(TRIM(?)) AND TRIM(?) != '')
          OR (TRIM(phone) = TRIM(?) AND TRIM(?) != '')
          OR (LOWER(TRIM(email)) = LOWER(TRIM(?)) AND TRIM(?) != '')
        ORDER BY scanned_at DESC LIMIT 5
      `).bind(name, name, phone, phone, email, email).all();
      return new Response(JSON.stringify(results), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- DELETE /contacts/:id â†’ contact verwijderen ---
    if (url.pathname.startsWith('/contacts/') && request.method === 'DELETE') {
      if (!checkPin(request, env)) return unauthorized();
      const id = url.pathname.split('/').pop();
      await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST /contacts â†’ contact opslaan ---
    if (url.pathname === '/contacts' && request.method === 'POST') {
      if (!checkPin(request, env)) return unauthorized();
      let body;
      try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      const { name='', org='', title='', phone='', email='', website='', replaceId=null } = body;
      if (replaceId) {
        await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(replaceId).run();
      }
      await env.DB.prepare(
        'INSERT INTO contacts (name,org,title,phone,email,website,scanned_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(name, org, title, phone, email, website, new Date().toISOString()).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    // --- POST / â†’ Anthropic API proxy ---
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
  if (!env.APP_PIN) return true; // geen PIN ingesteld â†’ open (tijdelijk)
  return request.headers.get('x-app-pin') === env.APP_PIN;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: { message: 'Ongeldige pincode' } }), {
    status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function loginHtml() {
  return `<!DOCTYPE html>
<html lang="nl"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contacten â€” inloggen</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#faf8f4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:#fff;border-radius:16px;padding:32px 28px;width:100%;max-width:340px;box-shadow:0 2px 16px rgba(0,0,0,.08);}
  h1{font-size:20px;font-weight:700;margin:0 0 6px;}
  p{color:#7a7367;font-size:14px;margin:0 0 20px;}
  input{width:100%;padding:12px 14px;border:1.5px solid #e4ddd1;border-radius:10px;font-size:16px;outline:none;}
  input:focus{border-color:#c4501c;}
  button{width:100%;margin-top:12px;padding:13px;background:#c4501c;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;}
  button:active{background:#a83210;}
  .err{color:#a83210;font-size:13px;margin-top:10px;display:none;}
</style></head>
<body><div class="card">
  <h1>Gescande contacten</h1>
  <p>Vul het wachtwoord in om je contacten te bekijken.</p>
  <input type="password" id="pw" placeholder="Wachtwoord" autofocus>
  <button onclick="login()">Inloggen</button>
  <div class="err" id="err">Ongeldig wachtwoord</div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('err');
  err.style.display = 'none';
  const res = await fetch('/contacts/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({token: pw})
  });
  if (!res.ok) { err.style.display = 'block'; return; }
  const rows = await res.json();
  document.open(); document.write(renderTable(rows)); document.close();
}
document.getElementById('pw').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderTable(rows){
  const r=rows.map(r=>\`<tr><td>\${esc(r.name)}</td><td>\${esc(r.org)}</td><td>\${esc(r.title)}</td><td><a href="tel:\${esc(r.phone)}">\${esc(r.phone)}</a></td><td><a href="mailto:\${esc(r.email)}">\${esc(r.email)}</a></td><td>\${r.website?\`<a href="\${esc(r.website)}" target="_blank">\${esc(r.website)}</a>\`:''}</td><td>\${esc((r.scanned_at||'').slice(0,10))}</td></tr>\`).join('');
  return \`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contacten</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;max-width:960px;margin:0 auto;}h1{font-size:22px;font-weight:700;margin-bottom:4px;}.sub{color:#7a7367;font-size:13px;margin-bottom:16px;}table{width:100%;border-collapse:collapse;font-size:13px;}th{text-align:left;padding:8px 10px;background:#f0ece4;border-bottom:2px solid #e4ddd1;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}td{padding:8px 10px;border-bottom:1px solid #f0ece4;vertical-align:top;}tr:hover td{background:#faf8f4;}a{color:#c4501c;text-decoration:none;}</style></head><body><h1>Gescande contacten</h1><p class="sub">\${rows.length} contact\${rows.length!==1?'en':''}</p><table><thead><tr><th>Naam</th><th>Bedrijf</th><th>Functie</th><th>Telefoon</th><th>E-mail</th><th>Website</th><th>Datum</th></tr></thead><tbody>\${r}</tbody></table></body></html>\`;
}
</script></body></html>`;
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

