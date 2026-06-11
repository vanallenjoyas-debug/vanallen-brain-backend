const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors({ origin: ["https://vanallenjoyas-debug.github.io", "http://localhost:3001"] }));
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IG_TOKEN = process.env.IG_TOKEN;
const VERSION = "1.0.1";
const IG_USER_ID = process.env.IG_USER_ID; // 17841429241098616

// ─── INIT DB ───────────────────────────────────────────────────────────────
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
      analysis TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS va_brand_voice (
      id SERIAL PRIMARY KEY,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

// ─── AUTH ───────────────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    res.json({ ok: true, token: 'va-session-ok' });
  } else {
    res.status(401).json({ error: 'Contraseña incorrecta' });
  }
});

// ─── FETCH POSTS FROM INSTAGRAM ─────────────────────────────────────────────
app.post('/api/sync-posts', async (req, res) => {
  try {
    let url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media?fields=id,caption,timestamp,like_count,comments_count,media_type,thumbnail_url,permalink&limit=50&access_token=${IG_TOKEN}`;
    let allPosts = [];

    // Paginar hasta traer todo el historial
    while (url) {
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) throw new Error(data.error.message);
      allPosts = allPosts.concat(data.data || []);
      url = data.paging?.next || null;
      if (allPosts.length >= 500) break; // tope de seguridad
    }

    // Para cada post traer insights (alcance y guardados)
    let saved = 0;
    for (const post of allPosts) {
      let reach = 0, savedCount = 0;
      try {
        const insR = await fetch(
          `https://graph.facebook.com/v19.0/${post.id}/insights?metric=reach,saved&access_token=${IG_TOKEN}`
        );
        const ins = await insR.json();
        if (ins.data) {
          ins.data.forEach(m => {
            if (m.name === 'reach') reach = m.values?.[0]?.value || 0;
            if (m.name === 'saved') savedCount = m.values?.[0]?.value || 0;
          });
        }
      } catch (e) { /* algunos posts no tienen insights */ }

      // Traer comentarios
      let commentsData = [];
      try {
        const commR = await fetch(
          `https://graph.facebook.com/v19.0/${post.id}/comments?fields=text,timestamp&limit=50&access_token=${IG_TOKEN}`
        );
        const comm = await commR.json();
        commentsData = comm.data || [];
      } catch (e) {}

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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET POSTS ───────────────────────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  const { show_excluded } = req.query;
  const rows = await pool.query(
    `SELECT * FROM va_posts ${show_excluded ? '' : 'WHERE excluded = FALSE'} ORDER BY like_count DESC`
  );
  res.json(rows.rows);
});

// ─── EXCLUIR / INCLUIR POST ──────────────────────────────────────────────────
app.post('/api/posts/:id/exclude', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/posts/:id/include', async (req, res) => {
  await pool.query('UPDATE va_posts SET excluded=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─── ANALIZAR PATRONES ────────────────────────────────────────────────────────
app.post('/api/analyze-patterns', async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT caption, like_count, comments_count, reach, saved, comments_data FROM va_posts WHERE excluded=FALSE ORDER BY like_count DESC LIMIT 100'
    );

    const postsText = rows.rows.map((p, i) =>
      `POST ${i+1}:
Caption: ${p.caption}
Likes: ${p.like_count} | Comentarios: ${p.comments_count} | Alcance: ${p.reach} | Guardados: ${p.saved}
Comentarios usuarios: ${JSON.parse(p.comments_data || '[]').slice(0,5).map(c => c.text).join(' | ')}`
    ).join('\n\n---\n\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Sos un analista de contenido para Van Allen Joyas, una marca de joyería artesanal argentina que vende talismanes y joyas con simbolismo vikingo, celta, wicca y esotérico.

Analizá estos posts de Instagram y detectá patrones. Respondé en español con este formato:

**TEMÁTICAS QUE FUNCIONAN**
[qué categorías de contenido generan más engagement]

**HOOKS QUE FUNCIONAN**
[tipos de apertura/gancho que funcionan mejor]

**TONO QUE FUNCIONA**
[descripción del tono y estilo que performa mejor]

**QUÉ DICE LA AUDIENCIA**
[patrones en los comentarios, qué le interesa a la gente]

**LO QUE NO FUNCIONA**
[qué tipo de posts tienen bajo rendimiento]

**RECOMENDACIONES CONCRETAS**
[3-5 acciones específicas para el contenido]

Posts a analizar:
${postsText}`
      }]
    });

    res.json({ analysis: msg.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GENERAR COPY ─────────────────────────────────────────────────────────────
app.post('/api/generate-copy', async (req, res) => {
  try {
    const { tema, formato } = req.body; // formato: feed | reel | story

    // Traer los 10 mejores posts como referencia de voz
    const rows = await pool.query(
      'SELECT caption, like_count FROM va_posts WHERE excluded=FALSE ORDER BY like_count DESC LIMIT 10'
    );
    const referencias = rows.rows.map(p => p.caption).filter(Boolean).join('\n---\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Sos el copywriter de Van Allen Joyas. Una marca de joyería artesanal argentina que trabaja simbolismo vikingo, celta, wicca y esotérico. La audiencia se siente identificada con la cultura y los valores, no necesariamente practica la religión.

VOZ DE LA MARCA:
- Segunda persona informal (vos)
- Evocador pero no fantástico
- No autoproclamar calidad
- Místico, con peso histórico y simbólico
- Sin lenguaje de marketing genérico

POSTS QUE MEJOR FUNCIONARON (para tomar la voz):
${referencias}

TAREA: Generá copy para ${formato || 'feed'} sobre el tema: "${tema}"

Generá 3 versiones diferentes. Para cada una incluí:
- Hook (primera línea gancho)
- Cuerpo del texto
- Call to action sutil`
      }]
    });

    res.json({ copy: msg.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Van Allen Brain backend running on port ${PORT}`);
});
