const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const VERSION = "1.5.0";
const app = express();
app.use(cors({ origin: ["https://vanallenjoyas-debug.github.io", "http://localhost:3001", "http://localhost:5500"] }));
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const IG_TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

function parseComments(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') { try { return JSON.parse(data); } catch(e) { return []; } }
  return data || [];
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS va_posts (
      id TEXT PRIMARY KEY,
      caption TEXT,
      manual_copy TEXT,
      timestamp TIMESTAMPTZ,
      like_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      reach INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0,
      media_type TEXT,
      thumbnail_url TEXT,
      media_url TEXT,
      permalink TEXT,
      excluded BOOLEAN DEFAULT FALSE,
      comments_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE va_posts ADD COLUMN IF NOT EXISTS manual_copy TEXT;
    ALTER TABLE va_posts ADD COLUMN IF NOT EXISTS media_url TEXT;
    CREATE TABLE IF NOT EXISTS va_ignored_comments (
      comment_hash TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS va_saved_results (
      key TEXT PRIMARY KEY,
      content TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

app.get('/api/version', (req, res) => res.json({ version: VERSION }));

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) res.json({ ok: true, token: 'va-session-ok' });
  else res.status(401).json({ error: 'Contrasena incorrecta' });
});

// SYNC
app.post('/api/sync-posts', async (req, res) => {
  try {
    let url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media?fields=id,caption,timestamp,like_count,comments_count,media_type,thumbnail_url,media_url,permalink&limit=50&access_token=${IG_TOKEN}`;
    let allPosts = [];
    while (url) {
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) throw new Error(data.error.message);
      allPosts = allPosts.concat(data.data || []);
      url = data.paging && data.paging.next ? data.paging.next : null;
      if (allPosts.length >= 500) break;
    }
    let saved = 0;
    for (const post of allPosts) {
      let reach = 0, savedCount = 0;
      try {
        const insR = await fetch(`https://graph.facebook.com/v19.0/${post.id}/insights?metric=reach,saved&access_token=${IG_TOKEN}`);
        const ins = await insR.json();
        if (ins.data) ins.data.forEach(m => {
          if (m.name === 'reach') reach = (m.values && m.values[0]) ? m.values[0].value : 0;
          if (m.name === 'saved') savedCount = (m.values && m.values[0]) ? m.values[0].value : 0;
        });
      } catch(e) {}
      let commentsData = [];
      try {
        const commR = await fetch(`https://graph.facebook.com/v19.0/${post.id}/comments?fields=text,timestamp&limit=50&access_token=${IG_TOKEN}`);
        const comm = await commR.json();
        commentsData = comm.data || [];
      } catch(e) {}
      // manual_copy NUNCA se toca
      await pool.query(`
        INSERT INTO va_posts (id, caption, timestamp, like_count, comments_count, reach, saved, media_type, thumbnail_url, media_url, permalink, comments_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET
          caption=$2, like_count=$4, comments_count=$5, reach=$6, saved=$7,
          thumbnail_url=$9, media_url=$10, permalink=$11, comments_data=$12, updated_at=NOW()
      `, [post.id, post.caption||'', post.timestamp, post.like_count||0, post.comments_count||0,
          reach, savedCount, post.media_type, post.thumbnail_url, post.media_url, post.permalink, JSON.stringify(commentsData)]);
      saved++;
    }
    res.json({ ok: true, synced: saved });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POSTS
app.get('/api/posts', async (req, res) => {
  try {
    const { show_excluded, sort, date_from, date_to, media_type } = req.query;
    let where = show_excluded ? [] : ['excluded = FALSE'];
    if (date_from) where.push(`timestamp >= '${date_from}'`);
    if (date_to) where.push(`timestamp <= '${date_to} 23:59:59'`);
    if (media_type === 'reels') where.push("media_type = 'VIDEO'");
    if (media_type === 'images') where.push("media_type IN ('IMAGE','CAROUSEL_ALBUM')");
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sortMap = { likes:'like_count DESC', comments:'comments_count DESC', reach:'reach DESC', saved:'saved DESC', date_desc:'timestamp DESC', date_asc:'timestamp ASC' };
    const orderBy = sortMap[sort] || 'like_count DESC';
    const rows = await pool.query(`SELECT * FROM va_posts ${whereStr} ORDER BY ${orderBy}`);
    res.json(rows.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/exclude', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/posts/:id/include', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// COPY MANUAL — nunca se borra
app.post('/api/posts/:id/copy', async (req, res) => {
  try {
    const { copy } = req.body;
    await pool.query('UPDATE va_posts SET manual_copy=$1 WHERE id=$2', [copy, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GUARDAR/TRAER RESULTADOS PERSISTENTES
app.get('/api/saved/:key', async (req, res) => {
  try {
    const row = await pool.query('SELECT content, updated_at FROM va_saved_results WHERE key=$1', [req.params.key]);
    if (row.rows.length) res.json({ content: row.rows[0].content, updated_at: row.rows[0].updated_at });
    else res.json({ content: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/saved/:key', async (req, res) => {
  try {
    const { content } = req.body;
    await pool.query(`INSERT INTO va_saved_results (key, content, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET content=$2, updated_at=NOW()`, [req.params.key, content]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ANALIZAR PATRONES
app.post('/api/analyze-patterns', async (req, res) => {
  try {
    const { media_type: mt } = req.body;
    const mtFilter = mt === 'reels' ? "AND media_type = 'VIDEO'" : mt === 'images' ? "AND media_type IN ('IMAGE','CAROUSEL_ALBUM')" : '';
    const rows = await pool.query(`SELECT caption, manual_copy, like_count, comments_count, reach, saved, comments_data FROM va_posts WHERE excluded=FALSE ${mtFilter} ORDER BY like_count DESC LIMIT 100`);
    if (!rows.rows.length) return res.status(400).json({ error: 'No hay posts' });
    const postsText = rows.rows.map((p,i) => {
      const contenido = p.manual_copy || p.caption || '(sin texto)';
      const comments = parseComments(p.comments_data).slice(0,5).map(c=>c.text).join(' | ');
      return `POST ${i+1}:\nContenido: ${contenido}\nLikes: ${p.like_count} | Comentarios: ${p.comments_count} | Alcance: ${p.reach} | Guardados: ${p.saved}\nComentarios: ${comments}`;
    }).join('\n\n---\n\n');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      messages: [{ role:'user', content:`Sos analista de contenido de Van Allen Joyas, joyeria argentina con simbolismo vikingo, celta, wicca, esoterico.\n\nAnaliza estos posts y detecta patrones. Responde en espanol:\n\n**TEMATICAS QUE FUNCIONAN**\n**HOOKS QUE FUNCIONAN**\n**TONO QUE FUNCIONA**\n**QUE DICE LA AUDIENCIA**\n**LO QUE NO FUNCIONA**\n**RECOMENDACIONES CONCRETAS**\n\nPosts:\n${postsText}` }]
    });
    const analysis = msg.content[0].text;
    // Guardar en DB
    await pool.query(`INSERT INTO va_saved_results (key,content,updated_at) VALUES ('patterns_analysis',$1,NOW()) ON CONFLICT (key) DO UPDATE SET content=$1,updated_at=NOW()`, [analysis]);
    res.json({ analysis });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GENERAR COPY
app.post('/api/generate-copy', async (req, res) => {
  try {
    const { tema, formato } = req.body;
    if (!tema) return res.status(400).json({ error: 'Falta el tema' });
    const { media_type: mt } = req.body;
    const mtFilter = mt === 'reels' ? "AND media_type = 'VIDEO'" : mt === 'images' ? "AND media_type IN ('IMAGE','CAROUSEL_ALBUM')" : '';
    const rows = await pool.query(`SELECT caption, manual_copy, like_count FROM va_posts WHERE excluded=FALSE ${mtFilter} ORDER BY like_count DESC LIMIT 15`);
    const referencias = rows.rows.map(p=>p.manual_copy||p.caption).filter(Boolean).join('\n---\n');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role:'user', content:`Sos el copywriter de Van Allen Joyas. Joyeria artesanal argentina con simbolismo vikingo, celta, wicca y esoterico.\n\nVOZ: segunda persona informal (vos), evocador, mistico con peso historico, sin autoproclamar calidad, sin marketing generico.\n\nREFERENCIA (posts que mejor funcionaron):\n${referencias}\n\nGenera 3 versiones de copy para ${formato||'feed'} sobre: "${tema}"\nPara cada una: Hook / Cuerpo / CTA sutil` }]
    });
    const copy = msg.content[0].text;
    // Guardar en DB con el tema como key
    const key = 'copy_' + tema.toLowerCase().replace(/\s+/g,'_').slice(0,40) + '_' + Date.now();
    await pool.query(`INSERT INTO va_saved_results (key,content,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET content=$2,updated_at=NOW()`, [key, JSON.stringify({tema, formato, copy})]);
    res.json({ copy, key });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// HISTORIAL DE COPYS GENERADOS
app.get('/api/copy-history', async (req, res) => {
  try {
    const rows = await pool.query(`SELECT key, content, updated_at FROM va_saved_results WHERE key LIKE 'copy_%' ORDER BY updated_at DESC LIMIT 50`);
    res.json(rows.rows.map(r => ({ key: r.key, updated_at: r.updated_at, ...JSON.parse(r.content) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// COMENTARIOS
app.get('/api/comments', async (req, res) => {
  try {
    const { sort, date_from, date_to } = req.query;
    let where = ['excluded=FALSE', 'comments_count > 0'];
    if (date_from) where.push(`timestamp >= '${date_from}'`);
    if (date_to) where.push(`timestamp <= '${date_to} 23:59:59'`);
    if (media_type === 'reels') where.push("media_type = 'VIDEO'");
    if (media_type === 'images') where.push("media_type IN ('IMAGE','CAROUSEL_ALBUM')");
    const sortMap = { likes:'like_count DESC', date_desc:'timestamp DESC', date_asc:'timestamp ASC' };
    const orderBy = sortMap[sort] || 'like_count DESC';
    const rows = await pool.query(`SELECT id, caption, like_count, timestamp, comments_data FROM va_posts WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`);
    const ignored = await pool.query('SELECT comment_hash FROM va_ignored_comments');
    const ignoredSet = new Set(ignored.rows.map(r=>r.comment_hash));
    let allComments = [];
    for (const post of rows.rows) {
      const comments = parseComments(post.comments_data);
      for (const c of comments) {
        if (!c.text || c.text.trim().length < 5) continue;
        const hash = Buffer.from(post.id+c.text).toString('base64').slice(0,32);
        if (ignoredSet.has(hash)) continue;
        allComments.push({ hash, text:c.text, post_id:post.id, post_caption:post.caption?post.caption.slice(0,60):'', post_likes:post.like_count, post_date:post.timestamp });
      }
    }
    allComments.sort((a,b)=>b.text.length-a.text.length);
    res.json(allComments.slice(0,300));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comments/ignore', async (req, res) => {
  const { hash } = req.body;
  await pool.query('INSERT INTO va_ignored_comments (comment_hash) VALUES ($1) ON CONFLICT DO NOTHING', [hash]);
  res.json({ ok: true });
});

app.post('/api/comments/analyze', async (req, res) => {
  try {
    const { comments } = req.body;
    if (!comments || !comments.length) return res.status(400).json({ error: 'No hay comentarios' });
    const texto = comments.map(c=>`- "${c.text}" (post: ${c.post_caption})`).join('\n');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1500,
      messages: [{ role:'user', content:`Analista de contenido de Van Allen Joyas (joyeria esoterica argentina).\n\nAnaliza estos comentarios:\n\n**QUE QUIERE SABER LA AUDIENCIA**\n**EMOCIONES Y CREENCIAS**\n**IDEAS DE CONTENIDO CONCRETAS**\n**FRASES QUE USA LA AUDIENCIA**\n\nComentarios:\n${texto}` }]
    });
    const analysis = msg.content[0].text;
    // Guardar
    await pool.query(`INSERT INTO va_saved_results (key,content,updated_at) VALUES ('comments_analysis',$1,NOW()) ON CONFLICT (key) DO UPDATE SET content=$1,updated_at=NOW()`, [analysis]);
    res.json({ analysis });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Van Allen Brain v${VERSION} running on port ${PORT}`);
});
