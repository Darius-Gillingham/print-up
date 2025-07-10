// File: s5/serverE.js
// Commit: switch to Supabase client SDK to avoid Postgres connection issues on Railway

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

app.get('/api/random-images', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('image_index')
      .select('path')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    const urls = data.map(row =>
      `${SUPABASE_URL}/storage/v1/object/public/generated-images/${row.path}`
    );

    res.json(urls);
  } catch (err) {
    console.error('✗ Error fetching images:', err.message);
    res.status(500).json({ error: 'Failed to fetch image URLs' });
  }
});

app.get('/health', (_, res) => {
  res.send('✓ Backend is alive');
});

app.listen(port, () => {
  console.log(`✓ serverE listening on port ${port}`);
});
