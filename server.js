const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const VERSION = "1.1.1";
const app = express();
app.use(cors({ origin: ["https://vanallenjoyas-debug.github.io", "http://localhost:3001", "http://localhost:5500"] }));
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const IG_TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS va_posts (
      id TEXT PRIMARY KEY,
      caption TEXT,
      timestamp TIMESTAMPTZ,
      like_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      reach INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0,
      media_type TEXT,
      thumbnail_url TEXT,
      permalink TEXT,
      excluded BOOLEAN DEFAULT FALSE,
      comments_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS va_ignored_comments (
      comment_hash TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

// VERSION
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// LOGIN
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    res.json({ ok: true, token: 'va-session-ok' });
  } else {
    res.status(401).json({ error: 'Contrasena incorrecta' });
  }
});

// SYNC POSTS
app.post('/api/sync-posts', async (req, res) => {
  try {
    let url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media?fields=id,caption,timestamp,like_count,comments_count,media_type,thumbnail_url,permalink&limit=50&access_token=${IG_TOKEN}`;
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
        if (ins.data) {
          ins.data.forEach(m => {
            if (m.name === 'reach') reach = (m.values && m.values[0]) ? m.values[0].value : 0;
            if (m.name === 'saved') savedCount = (m.values && m.values[0]) ? m.values[0].value : 0;
          });
        }
      } catch(e) {}

      let commentsData = [];
      try {
        const commR = await fetch(`https://graph.facebook.com/v19.0/${post.id}/comments?fields=text,timestamp&limit=50&access_token=${IG_TOKEN}`);
        const comm = await commR.json();
        commentsData = comm.data || [];
      } catch(e) {}

      await pool.query(`
        INSERT INTO va_posts (id, caption, timestamp, like_count, comments_count, reach, saved, media_type, thumbnail_url, permalink, comments_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          like_count=$4, comments_count=$5, reach=$6, saved=$7,
          comments_data=$11, updated_at=NOW()
      `, [post.id, post.caption || '', post.timestamp, post.like_count || 0,
          post.comments_count || 0, reach, savedCount,
          post.media_type, post.thumbnail_url, post.permalink,
          JSON.stringify(commentsData)]);
      saved++;
    }

    res.json({ ok: true, synced: saved });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET POSTS
app.get('/api/posts', async (req, res) => {
  try {
    const { show_excluded } = req.query;
    const rows = await pool.query(
      `SELECT * FROM va_posts ${show_excluded ? '' : 'WHERE excluded = FALSE'} ORDER BY like_count DESC`
    );
    res.json(rows.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// EXCLUIR / INCLUIR
app.post('/api/posts/:id/exclude', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/posts/:id/include', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ANALIZAR PATRONES
app.post('/api/analyze-patterns', async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT caption, like_count, comments_count, reach, saved, comments_data FROM va_posts WHERE excluded=FALSE ORDER BY like_count DESC LIMIT 100'
    );

    if (!rows.rows.length) return res.status(400).json({ error: 'No hay posts para analizar' });

    const postsText = rows.rows.map((p, i) =>
      `POST ${i+1}:\nCaption: ${p.caption}\nLikes: ${p.like_count} | Comentarios: ${p.comments_count} | Alcance: ${p.reach} | Guardados: ${p.saved}\nComentarios usuarios: ${( Array.isArray(p.comments_data) ? p.comments_data : (typeof p.comments_data === 'string' ? JSON.parse(p.comments_data || '[]') : p.comments_data || []) ).slice(0,5).map(c => c.text).join(' | ')}`
    ).join('\n\n---\n\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Sos un analista de contenido para Van Allen Joyas, marca de joyeria artesanal argentina que vende talismanes y joyas con simbolismo vikingo, celta, wicca y esoterico.

Analiza estos posts de Instagram y detecta patrones. Responde en espanol con este formato:

**TEMATICAS QUE FUNCIONAN**
[que categorias de contenido generan mas engagement]

**HOOKS QUE FUNCIONAN**
[tipos de apertura que funcionan mejor]

**TONO QUE FUNCIONA**
[descripcion del tono y estilo que performa mejor]

**QUE DICE LA AUDIENCIA**
[patrones en los comentarios]

**LO QUE NO FUNCIONA**
[que tipo de posts tienen bajo rendimiento]

**RECOMENDACIONES CONCRETAS**
[3-5 acciones especificas]

Posts:
${postsText}`
      }]
    });

    res.json({ analysis: msg.content[0].text });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GENERAR COPY
app.post('/api/generate-copy', async (req, res) => {
  try {
    const { tema, formato } = req.body;
    if (!tema) return res.status(400).json({ error: 'Falta el tema' });

    const rows = await pool.query(
      'SELECT caption, like_count FROM va_posts WHERE excluded=FALSE ORDER BY like_count DESC LIMIT 10'
    );
    const referencias = rows.rows.map(p => p.caption).filter(Boolean).join('\n---\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Sos el copywriter de Van Allen Joyas. Marca de joyeria artesanal argentina con simbolismo vikingo, celta, wicca y esoterico. La audiencia se identifica con la cultura y los valores, no necesariamente practica la religion.

VOZ DE LA MARCA:
- Segunda persona informal (vos)
- Evocador pero no fantastico
- No autoproclamar calidad
- Mistico, con peso historico y simbolico
- Sin lenguaje de marketing generico

POSTS QUE MEJOR FUNCIONARON (referencia de voz):
${referencias}

TAREA: Genera copy para ${formato || 'feed'} sobre: "${tema}"

Genera 3 versiones. Para cada una incluye:
- Hook (primera linea gancho)
- Cuerpo del texto
- Call to action sutil`
      }]
    });

    res.json({ copy: msg.content[0].text });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// COMENTARIOS
app.get('/api/comments', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, caption, like_count, comments_data FROM va_posts 
       WHERE excluded=FALSE AND comments_count > 0 
       ORDER BY like_count DESC`
    );

    const ignored = await pool.query('SELECT comment_hash FROM va_ignored_comments');
    const ignoredSet = new Set(ignored.rows.map(r => r.comment_hash));

    let allComments = [];
    for (const post of rows.rows) {
      let comments = [];
      comments = Array.isArray(post.comments_data) ? post.comments_data : (typeof post.comments_data === 'string' ? JSON.parse(post.comments_data || '[]') : post.comments_data || []);
      for (const c of comments) {
        if (!c.text || c.text.trim().length < 5) continue;
        const hash = Buffer.from(post.id + c.text).toString('base64').slice(0, 32);
        if (ignoredSet.has(hash)) continue;
        allComments.push({
          hash,
          text: c.text,
          post_id: post.id,
          post_caption: post.caption ? post.caption.slice(0, 60) : '',
          post_likes: post.like_count
        });
      }
    }

    allComments.sort((a, b) => b.text.length - a.text.length);
    res.json(allComments.slice(0, 200));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comments/ignore', async (req, res) => {
  const { hash } = req.body;
  await pool.query(
    'INSERT INTO va_ignored_comments (comment_hash) VALUES ($1) ON CONFLICT DO NOTHING',
    [hash]
  );
  res.json({ ok: true });
});

app.post('/api/comments/analyze', async (req, res) => {
  try {
    const { comments } = req.body;
    if (!comments || !comments.length) return res.status(400).json({ error: 'No hay comentarios' });

    const texto = comments.map(c => `- "${c.text}" (en post: ${c.post_caption})`).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Sos el analista de contenido de Van Allen Joyas, marca de joyeria con simbolismo vikingo, celta, wicca y esoterico.

Analiza estos comentarios de la audiencia y extrae insights para crear contenido. Responde en espanol:

**QUE QUIERE SABER LA AUDIENCIA**
[preguntas frecuentes, temas que generan curiosidad]

**EMOCIONES Y CREENCIAS**
[que sienten, en que creen, como se identifican]

**IDEAS DE CONTENIDO CONCRETAS**
[5-8 ideas especificas basadas en los comentarios]

**FRASES QUE USA LA AUDIENCIA**
[palabras y expresiones para usar en copys]

Comentarios:
${texto}`
      }]
    });

    res.json({ analysis: msg.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// START
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Van Allen Brain v${VERSION} running on port ${PORT}`);
});
